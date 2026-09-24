import { NextResponse, type NextRequest } from "next/server";
import { guardMutation } from "../../../../../server/api/guard-mutation";
import { jsonNotFound, jsonServerError } from "../../../../../server/api/responses";
import { recordAuditLog } from "../../../../../server/dal/audit-log";
import { softDeleteImportBatch } from "../../../../../server/dal/transactions";

/**
 * Undoes a whole statement import.
 *
 * The unit that actually matters. A statement writes hundreds of rows in
 * one go — a real one wrote 211 — so undoing row by row is not an undo,
 * and "a mistake is permanent" was the honest description of this app
 * before it existed.
 *
 * Every row is soft-deleted and each gets its own ledger commit, because
 * the hash chain is per-transaction and knows nothing about batches.
 * Deleting releases each row's dedupe key, so the corrected file can be
 * imported again afterwards.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ batchId: string }> }) {
  const guard = await guardMutation(request, "transactions:undo-import");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { batchId } = await params;

  try {
    const result = await softDeleteImportBatch(user.id, batchId);
    if (!result.ok) return jsonNotFound();

    await recordAuditLog(user.id, {
      action: "DELETE",
      entityType: "ImportBatch",
      entityId: batchId,
      afterData: { deletedCount: result.deletedCount },
    });

    return NextResponse.json({ ok: true, deletedCount: result.deletedCount });
  } catch (error) {
    console.error("undo import failed", error);
    return jsonServerError();
  }
}
