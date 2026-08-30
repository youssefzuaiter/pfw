import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonNotFound, jsonServerError } from "../../../../../../server/api/responses";
import { recordAuditLog } from "../../../../../../server/dal/audit-log";
import { removeMember, updateMemberPermission } from "../../../../../../server/dal/shared-groups";

const BodySchema = z.object({
  permission: z.enum(["READ", "WRITE"]),
});

/** Owner-only permission change — `updateMemberPermission`'s DAL doc comment explains why there's deliberately no self-service path. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; memberUserId: string }> },
) {
  const guard = await guardMutation(request, "groups:members:update");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { id: sharedGroupId, memberUserId } = await params;

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

  try {
    // "member_not_found"/"not_owner"/"cannot_edit_owner" are all reported
    // as 404 — same collapsing-to-404 convention `/api/categories/[id]`
    // uses for "is_uncategorized" (a business-rule rejection, not an IDOR
    // case, still folded into "not found" rather than growing a bespoke
    // status code per rejection reason).
    const result = await updateMemberPermission(user.id, sharedGroupId, memberUserId, parsed.data.permission);
    if (!result.ok) return jsonNotFound();

    await recordAuditLog(user.id, {
      entityType: "GroupMember",
      entityId: memberUserId,
      action: "UPDATE",
      afterData: { permission: parsed.data.permission },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("PATCH /api/groups/[id]/members/[memberUserId] failed", error);
    return jsonServerError();
  }
}

/** Self-leave or an owner removing a member — `removeMember`'s DAL doc comment covers both paths. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; memberUserId: string }> },
) {
  const guard = await guardMutation(request, "groups:members:remove");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { id: sharedGroupId, memberUserId } = await params;

  try {
    const result = await removeMember(user.id, sharedGroupId, memberUserId);
    if (!result.ok) return jsonNotFound();

    await recordAuditLog(user.id, {
      entityType: "GroupMember",
      entityId: memberUserId,
      action: "DELETE",
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("DELETE /api/groups/[id]/members/[memberUserId] failed", error);
    return jsonServerError();
  }
}
