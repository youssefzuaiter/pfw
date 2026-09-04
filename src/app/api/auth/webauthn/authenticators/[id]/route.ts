import { NextResponse, type NextRequest } from "next/server";
import { guardMutation } from "../../../../../../server/api/guard-mutation";
import { jsonNotFound } from "../../../../../../server/api/responses";
import { deleteAuthenticator } from "../../../../../../server/dal/authenticators";

/** Removes one of the caller's own passkeys. "Not found" covers both "doesn't exist" and "belongs to someone else" (Section 2.2). */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "webauthn:authenticators:delete");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  const { id } = await params;
  const deleted = await deleteAuthenticator(user.id, id);
  if (!deleted) return jsonNotFound();

  return NextResponse.json({ ok: true });
}
