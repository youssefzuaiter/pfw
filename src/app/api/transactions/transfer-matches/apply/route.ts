import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../../../server/api/responses";
import { recordAuditLog } from "../../../../../server/dal/audit-log";
import { applyTransferMatches, MAX_TRANSFER_PAIRS } from "../../../../../server/dal/transfer-matches";

const BodySchema = z.object({
  pairs: z
    .array(z.object({ outId: z.string().trim().min(1).max(60), inId: z.string().trim().min(1).max(60) }))
    .min(1, "Tick at least one pair")
    .max(MAX_TRANSFER_PAIRS, `Apply at most ${MAX_TRANSFER_PAIRS} pairs at a time`),
});

/**
 * Marks the ticked pairs as transfers between the user's own accounts
 * (AGENTS.md §3kkkk). The pairs are re-checked against the matcher on the
 * server, so only what it still proposes is applied; the rest is counted as
 * skipped. Undo is the existing bulk "unmark as transfer" on the returned ids.
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "transactions:transfer-matches");
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
    const result = await applyTransferMatches(user.id, parsed.data.pairs);

    if (result.applied > 0) {
      await recordAuditLog(user.id, {
        action: "UPDATE",
        entityType: "NotableTransaction",
        entityId: "bulk:transfer-matches",
        afterData: { pairs: result.applied, rows: result.changedIds.length },
      });
    }

    return NextResponse.json({ ok: true, applied: result.applied, skipped: result.skipped, changedIds: result.changedIds });
  } catch (error) {
    console.error("POST /api/transactions/transfer-matches/apply failed", error);
    return jsonServerError();
  }
}
