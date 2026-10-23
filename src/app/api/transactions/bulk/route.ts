import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../../server/api/responses";
import { recordAuditLog } from "../../../../server/dal/audit-log";
import { bulkEditTransactions, MAX_BULK_TRANSACTIONS } from "../../../../server/dal/transactions";

const BodySchema = z.object({
  ids: z.array(z.string().trim().min(1).max(60)).min(1, "Select at least one transaction").max(MAX_BULK_TRANSACTIONS, `Select at most ${MAX_BULK_TRANSACTIONS} transactions at a time`),
  action: z.discriminatedUnion("type", [
    z.object({ type: z.literal("category"), categoryId: z.string().trim().min(1).max(60) }),
    z.object({ type: z.literal("transfer"), isTransfer: z.boolean() }),
    z.object({ type: z.literal("delete") }),
    z.object({ type: z.literal("restore") }),
  ]),
});

/**
 * One edit applied to several transactions at once (AGENTS.md §3hhhh): set a
 * category, mark or unmark as a transfer, delete (soft, so it can be undone),
 * or restore. All or nothing. Ids that are not the caller's are counted as not
 * found, the same as ones that do not exist (Section 2.2).
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "transactions:bulk");
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
    const result = await bulkEditTransactions(user.id, parsed.data.ids, parsed.data.action);
    if (!result.ok) return jsonBadRequest("That category does not exist.");

    // One audit entry for the whole edit, not one per row.
    if (result.changedIds.length > 0) {
      await recordAuditLog(user.id, {
        action: parsed.data.action.type === "delete" ? "DELETE" : "UPDATE",
        entityType: "NotableTransaction",
        entityId: "bulk:transactions",
        afterData: { action: parsed.data.action.type, count: result.changedIds.length },
      });
    }

    return NextResponse.json({
      ok: true,
      changed: result.changedIds.length,
      changedIds: result.changedIds,
      skippedSplit: result.skippedSplit,
      unchanged: result.unchanged,
      notFound: result.notFound,
    });
  } catch (error) {
    console.error("POST /api/transactions/bulk failed", error);
    return jsonServerError();
  }
}
