import "server-only";
import argon2 from "argon2";
import { createAdminClient } from "../db/admin-client";
import { checkRateLimit } from "../api/rate-limit";
import { verifyTotpCode } from "./totp";

/**
 * Login and registration (AGENTS.md §3ff) — the credential-verification
 * half of real authentication. This is a bootstrap operation in exactly
 * the same sense `getCurrentUser()` already is: resolving "who is this"
 * (or creating a brand-new "who" during registration) has to run before
 * any `userId` exists to scope a normal `withUserScope` call by — the
 * `User` table's own RLS policy is keyed on already knowing the id. This
 * is the THIRD narrow, allowlisted admin-client exception alongside
 * `current-user.ts` and the household/vault invite-accept flows
 * (§3s/§3t), all sharing the identical justification —
 * see tests/guards/admin-client-boundary.test.ts.
 */

const PRIMARY_DEMO_USER_EMAIL = "demo@pfw.local"; // matches current-user.ts's own SEED_USER_EMAIL

/**
 * Login-attempt lockout (auth hardening pass, ad hoc post-§3ff) — the
 * same in-memory sliding-window limiter every other bootstrap route in
 * this app already uses (`POST /api/auth/register`'s per-email limit),
 * reused rather than a second hand-rolled "consecutive failures" counter
 * with its own reset-on-success bookkeeping. Keyed by the SUBMITTED
 * email (lowercased, matching Zod's own email normalization on the
 * client-facing routes), not by IP — bounds automated credential-
 * stuffing against one target account regardless of how many source IPs
 * an attacker rotates through, which a per-IP limit alone would miss.
 * Deliberately checked BEFORE `verifyCredentials` runs (auth.ts's
 * `authorize()`), so a locked-out account never even pays the Argon2id
 * hashing cost per attempt.
 */
export const LOGIN_RATE_LIMIT = { windowMs: 15 * 60 * 1000, maxRequests: 10 };

/** Key format shared with any caller that needs the full `checkRateLimit` result (e.g. a real HTTP 429 with a `Retry-After` header) rather than just this boolean — `POST /api/auth/webauthn/authenticate-options` calls `checkRateLimit(loginRateLimitKey(email), LOGIN_RATE_LIMIT)` directly for exactly that reason, reusing the SAME bucket rather than guessing at one. */
export function loginRateLimitKey(email: string): string {
  return `auth:login:${email.trim().toLowerCase()}`;
}

export function checkLoginRateLimit(email: string): boolean {
  return checkRateLimit(loginRateLimitKey(email), LOGIN_RATE_LIMIT).allowed;
}

export type VerifiedUser = { id: string; email: string; displayName: string; tokenVersion: number };

/**
 * Returns `null` on ANY failure (unknown email, no password set yet —
 * i.e. an unclaimed seeded row, or a wrong password) — deliberately the
 * same shape of response for all three, so a login form can't be used to
 * enumerate which emails exist in the system. `argon2.verify` is
 * constant-time by construction (it's comparing against a real
 * Argon2id hash, not a plaintext), so no separate timing-safe-compare
 * step is needed the way `isTrustedOrigin` (§3g) needed one for a
 * different kind of value.
 */
export async function verifyCredentials(email: string, password: string): Promise<VerifiedUser | null> {
  const admin = createAdminClient();
  const user = await admin.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) return null;

  const valid = await argon2.verify(user.passwordHash, password).catch(() => false);
  if (!valid) return null;

  return { id: user.id, email: user.email, displayName: user.displayName, tokenVersion: user.tokenVersion };
}

export type TotpChallengeResult = "not_required" | "required" | "invalid" | "valid";

/**
 * TOTP MFA (Punch List Tier 2, item 3) — the second half of `authorize()`'s
 * two-factor check, only ever called AFTER `verifyCredentials` has already
 * confirmed the password, so this never runs (and therefore never reveals
 * whether MFA is enabled) for a request that got the password wrong.
 * "required" vs. "invalid" are deliberately distinct outcomes (unlike
 * `verifyCredentials`'s uniform `null`): the client already proved
 * password knowledge at this point, so telling it "enter your code" vs.
 * "that code was wrong" is normal, expected two-factor UX, not an
 * enumeration risk the way revealing account existence pre-password would
 * be.
 */
export async function checkTotpChallenge(userId: string, code: string | undefined): Promise<TotpChallengeResult> {
  const admin = createAdminClient();
  const user = await admin.user.findUnique({
    where: { id: userId },
    select: { totpEnabled: true, totpSecret: true, totpLastUsedTimeStep: true },
  });
  if (!user?.totpEnabled || !user.totpSecret) return "not_required";
  if (!code) return "required";

  const result = await verifyTotpCode(user.totpSecret, code, user.totpLastUsedTimeStep);
  if (!result.valid) return "invalid";

  // Replay protection (totp.ts's own doc comment) — persisted here, not
  // just checked, so the SAME code can never be accepted a second time
  // within its own validity window.
  await admin.user.update({ where: { id: userId }, data: { totpLastUsedTimeStep: result.timeStep } });
  return "valid";
}

export type RegisterResult = { ok: true; userId: string; inherited: boolean } | { ok: false; error: "email_taken" };

/**
 * The "first registration inherits the seeded demo data" mechanism
 * (AGENTS.md §3ff, a user-confirmed decision, not assumed) — claims the
 * SPECIFIC primary demo user row (`demo@pfw.local`), never an arbitrary
 * unclaimed one. This app's seed script also creates two household-
 * member rows (Dana, Avi — §3s) that are unclaimed in exactly the same
 * `passwordHash: null` sense but must NEVER be claimed by a real
 * registration — they're the other side of a shared-household
 * relationship in the demo data, not accounts anyone is meant to log
 * into directly. Only the row matching PRIMARY_DEMO_USER_EMAIL is
 * eligible, checked explicitly by email, not by "any row with a null
 * password."
 *
 * The email-uniqueness check excludes the demo row's OWN id while
 * claiming it — its existing email is about to be overwritten by
 * whatever the registrant chose, so it must not count as "taken"
 * against itself (this also correctly allows registering with the
 * literal email `demo@pfw.local`, which simply claims the row with no
 * email change).
 */
export async function registerUser(email: string, password: string, displayName: string): Promise<RegisterResult> {
  const admin = createAdminClient();
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  const primaryDemoUser = await admin.user.findUnique({ where: { email: PRIMARY_DEMO_USER_EMAIL } });
  const isClaimingDemoAccount = primaryDemoUser !== null && primaryDemoUser.passwordHash === null;

  const conflictingUser = await admin.user.findFirst({
    where: {
      email,
      ...(isClaimingDemoAccount ? { id: { not: primaryDemoUser!.id } } : {}),
    },
  });
  if (conflictingUser) return { ok: false, error: "email_taken" };

  if (isClaimingDemoAccount) {
    const claimed = await admin.user.update({
      where: { id: primaryDemoUser!.id },
      data: { email, displayName, passwordHash },
    });
    return { ok: true, userId: claimed.id, inherited: true };
  }

  const created = await admin.user.create({ data: { email, displayName, passwordHash } });
  return { ok: true, userId: created.id, inherited: false };
}
