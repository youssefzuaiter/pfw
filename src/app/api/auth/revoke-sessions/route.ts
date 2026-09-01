import { NextResponse, type NextRequest } from "next/server";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonServerError } from "../../../../server/api/responses";
import { bumpTokenVersion } from "../../../../server/auth/token-version";

/**
 * Server-side JWT revocation's one explicit, user-triggered entry point
 * (Punch List Tier 2, item 2 — see `token-version.ts`'s own doc comment).
 * This bumps tokenVersion for EVERY session, the calling one included —
 * the client is expected to immediately `signOut()` and redirect to
 * `/login` on success rather than continuing to rely on this same
 * request's own session, which is now stale by construction.
 */
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 5 };

export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "auth:revoke-sessions", RATE_LIMIT);
  if ("response" in guard) return guard.response;
  const { user } = guard;

  try {
    await bumpTokenVersion(user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("POST /api/auth/revoke-sessions failed", error);
    return jsonServerError();
  }
}
