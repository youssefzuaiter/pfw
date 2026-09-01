import "server-only";
import { withUserScope } from "../db/with-user-scope";

/**
 * Server-side JWT revocation (Punch List Tier 2, item 2). Unlike
 * `current-user.ts`'s admin-client bootstrap exception, these two
 * functions are always called with an ALREADY-trusted user id — either
 * cryptographically verified inside a signed Auth.js session token
 * (`auth.ts`'s `jwt()` callback), or resolved via `getCurrentUser()`
 * upstream of a normal mutating route — so there's no chicken-and-egg
 * identity problem here to justify bypassing RLS. Both go through the
 * ordinary `withUserScope`-scoped runtime client; `User`'s own RLS
 * policies (self-select/self-update, §3s) already permit exactly this.
 */

export async function getCurrentTokenVersion(userId: string): Promise<number | null> {
  const user = await withUserScope(userId, (tx) =>
    tx.user.findUnique({ where: { id: userId }, select: { tokenVersion: true } }),
  );
  return user?.tokenVersion ?? null;
}

/**
 * Invalidates every OUTSTANDING session token for this user — including,
 * necessarily, the very session that called this (its own token still
 * carries the pre-bump version, so it fails the next `jwt()` check just
 * like any other now-stale token). Callers that want a clean UX after
 * bumping their own tokenVersion should immediately `signOut()`
 * client-side and redirect to `/login`, rather than waiting for the
 * mismatch to surface as an unexpected mid-session logout. Currently
 * wired to two real, callable actions: the "Sign out of all sessions"
 * settings action, and disabling TOTP MFA (a real security-posture
 * downgrade worth forcing re-authentication everywhere for).
 */
export async function bumpTokenVersion(userId: string): Promise<number> {
  const updated = await withUserScope(userId, (tx) =>
    tx.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
      select: { tokenVersion: true },
    }),
  );
  return updated.tokenVersion;
}
