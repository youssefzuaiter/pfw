import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonForbidden, jsonServerError } from "../../../../../server/api/responses";
import { recordAuditLog } from "../../../../../server/dal/audit-log";
import { createGroupInvite } from "../../../../../server/dal/shared-groups";

const BodySchema = z.object({
  email: z.string().trim().email(),
  permission: z.enum(["READ", "WRITE"]).default("READ"),
  expiresInDays: z.number().int().min(1).max(30).optional(),
});

/**
 * Creates an invite token for a Household Space. Owner-only, enforced in
 * the DAL (`createGroupInvite`) — a non-owner or non-member gets the same
 * `not_owner` rejection, which this route maps to `403` (a request-level
 * policy violation, not an ownership/IDOR case — the group itself isn't
 * hidden from a member who just lacks OWNER standing, unlike a 404 for a
 * resource you can't see at all).
 *
 * The raw, single-use token is returned in the response body exactly
 * once and never stored (only its hash is) — this app has no outbound
 * email infrastructure, so the caller is responsible for relaying it to
 * the invitee out-of-band. See AGENTS.md §3s.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "groups:invite");
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
    const result = await createGroupInvite(
      user.id,
      sharedGroupId,
      parsed.data.email,
      parsed.data.permission,
      parsed.data.expiresInDays,
    );
    if (!result.ok) return jsonForbidden("Only the household's owner can invite members");

    await recordAuditLog(user.id, {
      entityType: "GroupInvite",
      entityId: result.invite.id,
      action: "CREATE",
      afterData: { invitedEmail: result.invite.invitedEmail, permission: result.invite.permission },
    });

    return NextResponse.json(
      {
        ok: true,
        invite: {
          id: result.invite.id,
          invitedEmail: result.invite.invitedEmail,
          permission: result.invite.permission,
          expiresAt: result.invite.expiresAt.toISOString(),
        },
        token: result.rawToken,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("POST /api/groups/[id]/invites failed", error);
    return jsonServerError();
  }
}
