import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../../../server/api/responses";
import { recordAuditLog } from "../../../../../server/dal/audit-log";
import { applyDebtPaymentMatches, MAX_DEBT_PAYMENTS_PER_APPLY } from "../../../../../server/dal/debt-payment-matches";

const BodySchema = z.object({
  items: z
    .array(z.object({ debtId: z.string().trim().min(1).max(60), transactionId: z.string().trim().min(1).max(60) }))
    .min(1, "Tick at least one payment")
    .max(MAX_DEBT_PAYMENTS_PER_APPLY, `Record at most ${MAX_DEBT_PAYMENTS_PER_APPLY} payments at a time`),
});

/**
 * Records repayments already in the ledger as payments of their debts
 * (AGENTS.md §3nnnn). Each one reduces the debt's balance, so it is checked
 * again on the server: only what the matcher still proposes, and has not been
 * recorded, is applied; the rest is counted as skipped. All or nothing.
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "debts:payment-matches");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonBadRequest("Request body must be valid JSON.");
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return jsonBadRequest(parsed.error.issues[0]?.message ?? "Invalid request body.");

  try {
    const result = await applyDebtPaymentMatches(user.id, parsed.data.items);
    if (result.applied > 0) {
      await recordAuditLog(user.id, {
        action: "CREATE",
        entityType: "DebtPayment",
        entityId: "bulk:payment-matches",
        afterData: { payments: result.applied },
      });
    }
    return NextResponse.json({ ok: true, applied: result.applied, skipped: result.skipped });
  } catch (error) {
    console.error("POST /api/debts/payment-matches/apply failed", error);
    return jsonServerError();
  }
}
