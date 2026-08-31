import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonNotFound, jsonServerError } from "../../../../../server/api/responses";
import { recordAuditLog } from "../../../../../server/dal/audit-log";
import { transferGroupOwnership } from "../../../../../server/dal/shared-groups";

const BodySchema = z.object({
  newOwnerUserId: z.string().min(1),
});

/**
 * Transfers a Household Space's ownership to an existing, non-owner
 * member — see `transferGroupOwnership`'s DAL doc comment for the
 * ordering that makes this atomic under RLS, and migration
 * `20260903090000_shared_group_ownership_transfer` for why this needed a
 * one-line RLS policy widening to even be possible.
 *
 * "target_not_found" and "target_already_owner" both collapse to 404,
 * same as every other owner-only DAL rejection in this route family —
 * neither reveals more than "this operation can't be performed."
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "groups:transfer-ownership");
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
    const result = await transferGroupOwnership(user.id, sharedGroupId, parsed.data.newOwnerUserId);
    if (!result.ok) return jsonNotFound();

    await recordAuditLog(user.id, {
      entityType: "SharedGroup",
      entityId: sharedGroupId,
      action: "UPDATE",
      afterData: { newOwnerUserId: parsed.data.newOwnerUserId },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("POST /api/groups/[id]/transfer-ownership failed", error);
    return jsonServerError();
  }
}
