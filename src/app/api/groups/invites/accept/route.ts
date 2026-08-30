import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardMutation } from "../../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../../../server/api/responses";
import { recordAuditLog } from "../../../../../server/dal/audit-log";
import { acceptGroupInvite } from "../../../../../server/dal/shared-groups";

const BodySchema = z.object({
  token: z.string().min(1),
});

const ERROR_MESSAGES: Record<string, string> = {
  invalid_token: "This invite link isn't valid.",
  already_used: "This invite has already been used or was revoked.",
  expired: "This invite has expired.",
  already_member: "You're already a member of this household.",
};

/**
 * Accepts an invite by its raw token, creating the caller's own
 * `GroupMember` row (AGENTS.md §3s). Every rejection reason returns 400
 * with a distinct, user-facing message rather than a generic error — none
 * of these leak information a well-behaved client couldn't already infer
 * from having (or not having) a valid-looking token in hand.
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "groups:invites:accept");
  if ("response" in guard) return guard.response;
  const { user } = guard;

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
    const result = await acceptGroupInvite(user.id, parsed.data.token);
    if (!result.ok) {
      return jsonBadRequest(ERROR_MESSAGES[result.error]);
    }

    await recordAuditLog(user.id, {
      entityType: "GroupMember",
      entityId: result.sharedGroupId,
      action: "CREATE",
      afterData: { sharedGroupId: result.sharedGroupId },
    });

    return NextResponse.json({ ok: true, sharedGroupId: result.sharedGroupId });
  } catch (error) {
    console.error("POST /api/groups/invites/accept failed", error);
    return jsonServerError();
  }
}
