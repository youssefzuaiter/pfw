import { NextResponse, type NextRequest } from "next/server";
import { guardMutation } from "../../../../../../server/api/guard-mutation";
import { jsonNotFound, jsonServerError } from "../../../../../../server/api/responses";
import { recordAuditLog } from "../../../../../../server/dal/audit-log";
import { revokeGroupInvite } from "../../../../../../server/dal/shared-groups";

/** Revokes a still-pending invite. `not_found`/`not_pending` both map to 404 — see bank-accounts.ts's DAL doc comment for why a mismatch and a nonexistent id are made indistinguishable everywhere in this app. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string; inviteId: string }> }) {
  const guard = await guardMutation(request, "groups:invites:revoke");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { inviteId } = await params;

  try {
    const result = await revokeGroupInvite(user.id, inviteId);
    if (!result.ok) return jsonNotFound();

    await recordAuditLog(user.id, {
      entityType: "GroupInvite",
      entityId: inviteId,
      action: "UPDATE",
      afterData: { status: "REVOKED" },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("DELETE /api/groups/[id]/invites/[inviteId] failed", error);
    return jsonServerError();
  }
}
