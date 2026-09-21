import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseDecimalToNativeAmount, SUPPORTED_CURRENCIES } from "../../../lib/currency";
import { guardMutation } from "../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../server/api/responses";
import { recordAuditLog } from "../../../server/dal/audit-log";
import { createBankAccount } from "../../../server/dal/bank-accounts";

const ACCOUNT_TYPES = ["CHECKING", "SAVINGS", "CREDIT_CARD"] as const;

const BodySchema = z.object({
  institutionName: z.string().trim().min(1).max(80),
  last4: z.string().regex(/^\d{4}$/, "last4 must be exactly 4 digits"),
  accountType: z.enum(ACCOUNT_TYPES),
  nickname: z.string().trim().min(1).max(80).optional(),
  // Derived from the one canonical list so a new currency can't be
  // accepted by the schema and rejected here (or vice versa).
  currency: z.enum(SUPPORTED_CURRENCIES).optional(),
  // A plain decimal string, e.g. "1250.00" — never signed with a "-" here:
  // a CHECKING/SAVINGS opening balance and a CREDIT_CARD "amount owed" are
  // both entered as a positive figure by the user (the schema's own
  // "positive = money owed" convention for a credit card is applied by
  // net-worth.ts's own liability classification, not by the sign of what
  // gets typed in here).
  nativeBalance: z.string().min(1),
});

/**
 * Manual bank-account creation — see `createBankAccount`'s own doc
 * comment for the gap this closes. `guardMutation` already resolves a
 * real, authenticated `userId` — there is no way to create an account
 * for anyone but yourself.
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "bank-accounts:create");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonBadRequest("Request body must be valid JSON");
  }

  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return jsonBadRequest("Invalid request body", parsed.error.issues);
  }

  let nativeBalance: ReturnType<typeof parseDecimalToNativeAmount>;
  try {
    nativeBalance = parseDecimalToNativeAmount(parsed.data.nativeBalance);
  } catch {
    return jsonBadRequest("Invalid balance");
  }
  if (nativeBalance < 0) {
    return jsonBadRequest("Balance must not be negative");
  }

  try {
    const account = await createBankAccount(user.id, {
      institutionName: parsed.data.institutionName,
      last4: parsed.data.last4,
      accountType: parsed.data.accountType,
      nickname: parsed.data.nickname,
      currency: parsed.data.currency,
      nativeBalance: BigInt(nativeBalance),
    });

    await recordAuditLog(user.id, {
      entityType: "BankAccount",
      entityId: account.id,
      action: "CREATE",
      afterData: { institutionName: account.institutionName, accountType: account.accountType },
    });

    return NextResponse.json(
      {
        ok: true,
        account: {
          id: account.id,
          institutionName: account.institutionName,
          accountType: account.accountType,
          nickname: account.nickname,
          currency: account.currency,
          nativeBalance: Number(account.nativeBalance),
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("POST /api/bank-accounts failed", error);
    return jsonServerError();
  }
}
