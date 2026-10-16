import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseDecimalToNativeAmount } from "../../../../lib/currency";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonNotFound, jsonServerError } from "../../../../server/api/responses";
import { recordAuditLog } from "../../../../server/dal/audit-log";
import { reconcileBankAccount } from "../../../../server/dal/bank-accounts";

const BodySchema = z.object({
  /** A plain decimal string, never negative: a card's "amount owed" is entered positive too. */
  nativeBalance: z.string().min(1),
  /** The day the balance is true for, `YYYY-MM-DD`. */
  balanceAsOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "balanceAsOf must be a YYYY-MM-DD date"),
});

/**
 * Re-states an account's balance as of a day (see `reconcileBankAccount`).
 * Transactions dated on or after the next day are rolled forward from it by
 * Safe to Spend. A day in the future is refused: nothing after today can have
 * happened yet, and it would hide today's real transactions.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "bank-accounts:reconcile");
  if ("response" in guard) return guard.response;
  const { user } = guard;
  const { id } = await params;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonBadRequest("Request body must be valid JSON");
  }
  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) return jsonBadRequest("Invalid request body", parsed.error.issues);

  const balanceAsOf = new Date(`${parsed.data.balanceAsOf}T00:00:00.000Z`);
  if (Number.isNaN(balanceAsOf.getTime()) || balanceAsOf.toISOString().slice(0, 10) !== parsed.data.balanceAsOf) {
    return jsonBadRequest("Invalid balanceAsOf date");
  }
  if (balanceAsOf.getTime() > Date.now()) return jsonBadRequest("balanceAsOf cannot be in the future");

  let nativeBalance: ReturnType<typeof parseDecimalToNativeAmount>;
  try {
    nativeBalance = parseDecimalToNativeAmount(parsed.data.nativeBalance);
  } catch {
    return jsonBadRequest("Invalid balance");
  }
  if (nativeBalance < 0) return jsonBadRequest("Balance must not be negative");

  try {
    const result = await reconcileBankAccount(user.id, id, { nativeBalance: BigInt(nativeBalance), balanceAsOf });
    // Not found covers both a nonexistent id and another user's account (Section 2.2).
    if (!result.ok) return jsonNotFound();

    await recordAuditLog(user.id, {
      entityType: "BankAccount",
      entityId: id,
      action: "UPDATE",
      afterData: { balanceAsOf: parsed.data.balanceAsOf },
    });
    return NextResponse.json({
      ok: true,
      account: { id, nativeBalance: Number(result.nativeBalance), balanceAsOf: parsed.data.balanceAsOf },
    });
  } catch (error) {
    console.error("PATCH /api/bank-accounts/[id] failed", error);
    return jsonServerError();
  }
}
