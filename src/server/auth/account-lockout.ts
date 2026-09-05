import "server-only";
import { createAdminClient } from "../db/admin-client";

/**
 * Account lockout (Phase 3, Security & Recovery) — the SEVENTH narrow,
 * allowlisted admin-client bootstrap exception, same justification every
 * prior one shares: every call here happens from inside `authorize()`
 * (a wrong password, a wrong TOTP code, a failed passkey assertion),
 * before any session exists to scope a normal `withUserScope` call by.
 * See tests/guards/admin-client-boundary.test.ts.
 *
 * Deliberately a real, DB-persisted lock (`User.accountLockedAt`), not
 * `rate-limit.ts`'s in-memory sliding window `credentials.ts`'s
 * `checkLoginRateLimit` already uses for a DIFFERENT purpose (bounding
 * request VOLUME, self-resetting after its window elapses) — a lockout
 * that must survive until an explicit unlock action (a recovery code or
 * a password reset), and across however many separate serverless
 * function instances a real Vercel deployment spreads requests over,
 * cannot be an in-memory counter the way that rate limiter's own doc
 * comment already flags as "correct for this app's current single-
 * instance deployment" and nothing stronger.
 */

export const LOCKOUT_THRESHOLD = 5;

/**
 * Increments the consecutive-failure counter and locks the account once
 * it reaches `LOCKOUT_THRESHOLD` — returns `true` exactly when THIS call
 * is what just locked it (either it was already locked from an earlier
 * attempt, or this attempt is the one that crossed the threshold), so a
 * caller can decide whether to surface a distinct "account locked" error
 * for the current request.
 */
export async function recordFailedLoginAttempt(userId: string): Promise<boolean> {
  const admin = createAdminClient();
  const updated = await admin.user.update({
    where: { id: userId },
    data: { failedLoginAttempts: { increment: 1 } },
    select: { failedLoginAttempts: true, accountLockedAt: true },
  });
  if (updated.accountLockedAt) return true;
  if (updated.failedLoginAttempts < LOCKOUT_THRESHOLD) return false;

  await admin.user.update({ where: { id: userId }, data: { accountLockedAt: new Date() } });
  return true;
}

/**
 * The "unlock" side — called on any fully successful sign-in (password
 * + TOTP if enabled, or a successful passkey assertion), AND, per this
 * phase's own explicit requirement, on a successful recovery-code
 * redemption or a completed password reset — the only three events that
 * clear a real lock, never the mere passage of time.
 */
export async function resetFailedLoginAttempts(userId: string): Promise<void> {
  const admin = createAdminClient();
  await admin.user.update({ where: { id: userId }, data: { failedLoginAttempts: 0, accountLockedAt: null } });
}
