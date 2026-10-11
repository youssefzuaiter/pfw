import { NextResponse, type NextRequest } from "next/server";
import { guardMutation } from "../../../../../../server/api/guard-mutation";
import { jsonNotFound, jsonServerError } from "../../../../../../server/api/responses";
import { recordAuditLog } from "../../../../../../server/dal/audit-log";
import { restoreImportBatch } from "../../../../../../server/dal/transactions";

/**
 * Restores every deleted row of one statement import — the way back from
 * "Undo import". Rows that are still live are untouched, and each restored
 * row appends its own RESTORE commit to the ledger chain. A row whose
 * dedupe key was taken in the meantime (the same file imported again after
 * the undo) comes back without it rather than failing the whole batch.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ batchId: string }> }) {
  const guard = await guardMutation(request, "transactions:restore-import");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { batchId } = await params;

  try {
    const result = await restoreImportBatch(user.id, batchId);
    // Nothing to restore covers a nonexistent batch, another user's, and
    // one with no deleted rows left (Section 2.2) — never a 403.
    if (!result.ok) return jsonNotFound();

    await recordAuditLog(user.id, {
      action: "UPDATE",
      entityType: "ImportBatch",
      entityId: batchId,
      afterData: { restoredCount: result.deletedCount },
    });

    return NextResponse.json({ ok: true, restoredCount: result.deletedCount });
  } catch (error) {
    console.error("restore import failed", error);
    return jsonServerError();
  }
}
