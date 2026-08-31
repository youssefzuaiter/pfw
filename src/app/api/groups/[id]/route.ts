import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonNotFound, jsonServerError } from "../../../../server/api/responses";
import { recordAuditLog } from "../../../../server/dal/audit-log";
import { deleteSharedGroup, renameSharedGroup } from "../../../../server/dal/shared-groups";

const BodySchema = z.object({
  name: z.string().trim().min(1).max(100),
});

/** Owner-only rename — see `renameSharedGroup`'s DAL doc comment. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "groups:rename");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { id: sharedGroupId } = await params;

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
    // "not_owner" collapses to 404 — same convention every other
    // owner-only DAL rejection in this file's sibling routes uses
    // (/api/groups/[id]/members/[memberUserId]) rather than a bespoke 403.
    const result = await renameSharedGroup(user.id, sharedGroupId, parsed.data.name);
    if (!result.ok) return jsonNotFound();

    await recordAuditLog(user.id, {
      entityType: "SharedGroup",
      entityId: sharedGroupId,
      action: "UPDATE",
      afterData: { name: parsed.data.name },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("PATCH /api/groups/[id] failed", error);
    return jsonServerError();
  }
}

/**
 * Owner-only delete. Cascade/un-share handling needs no DAL logic beyond
 * the delete itself — see `deleteSharedGroup`'s doc comment for why the
 * schema's own FK constraints already do the right thing for every
 * related row.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "groups:delete");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { id: sharedGroupId } = await params;

  try {
    const result = await deleteSharedGroup(user.id, sharedGroupId);
    if (!result.ok) return jsonNotFound();

    await recordAuditLog(user.id, { entityType: "SharedGroup", entityId: sharedGroupId, action: "DELETE" });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("DELETE /api/groups/[id] failed", error);
    return jsonServerError();
  }
}
