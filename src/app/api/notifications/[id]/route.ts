import { NextResponse, type NextRequest } from "next/server";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonNotFound } from "../../../../server/api/responses";
import { dismissNotification } from "../../../../server/dal/notifications";

/** Dismisses (marks read) one of the caller's own notifications. "Not found" covers both "doesn't exist" and "belongs to someone else" (Section 2.2). */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "notifications:dismiss");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { id } = await params;
  const dismissed = await dismissNotification(user.id, id);
  if (!dismissed) return jsonNotFound();

  return NextResponse.json({ ok: true });
}
