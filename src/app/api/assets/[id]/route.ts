import { NextResponse, type NextRequest } from "next/server";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonNotFound, jsonServerError } from "../../../../server/api/responses";
import { recordAuditLog } from "../../../../server/dal/audit-log";
import { deleteManualAsset } from "../../../../server/dal/manual-assets";

/**
 * Hard delete. "Not found" covers both "doesn't exist" and "belongs to
 * someone else" (Section 2.2's IDOR shape). Distinct from the crypto
 * wallet delete route (`/api/crypto-wallets/[id]`) — a manual asset and a
 * tracked wallet are separate models on this screen.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "assets:delete");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { id } = await params;

  try {
    const result = await deleteManualAsset(user.id, id);
    if (!result.ok) return jsonNotFound();

    await recordAuditLog(user.id, {
      entityType: "ManualAsset",
      entityId: id,
      action: "DELETE",
      beforeData: { name: result.name },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("DELETE /api/assets/[id] failed", error);
    return jsonServerError();
  }
}
