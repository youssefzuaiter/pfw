import "server-only";
import { createAdminClient } from "../db/admin-client";

/**
 * Auth hardening pass (ad hoc, post-§3ff) — the FOURTH narrow,
 * allowlisted admin-client bootstrap exception (alongside
 * `current-user.ts`, the household/vault invite flows, and
 * `credentials.ts`'s login/registration), same justification each time:
 * a password-reset request/confirm or an email-verification confirm both
 * run UNAUTHENTICATED — by definition, for reset (that's why they're
 * resetting) and by design for verification (the link may be opened in a
 * browser with no session at all) — so there is no `userId` yet to scope
 * a normal `withUserScope` transaction by. `PasswordResetToken`/
 * `EmailVerificationToken`'s own RLS policy (the migration's own comment)
 * documents this same exception. See
 * tests/guards/admin-client-boundary.test.ts.
 */

export async function adminFindUserByEmail(email: string) {
  const admin = createAdminClient();
  return admin.user.findUnique({ where: { email } });
}

/**
 * Deliberately a SEPARATE `admin.user.findUnique` call, never an
 * `include: { user: true }` on a token query (see the real bug this
 * caused, fixed in this same pass, below) — `User.totpSecret` is AES-
 * 256-GCM ciphertext at rest, transparently decrypted by
 * `encrypted-fields.ts`'s Prisma Client extension, but that extension is
 * registered per-model on `user`'s own top-level operations only
 * (`withEncryptedFields`'s `query: { user: {...} }`); a NESTED `user`
 * relation returned from a *different* model's query (e.g.
 * `passwordResetToken.findUnique({ include: { user: true } })`) never
 * passes through it, so `record.user.totpSecret` there is raw
 * ciphertext, not the real secret. `confirmPasswordReset`'s TOTP check
 * silently failed every single time because of exactly this — caught by
 * this pass's own integration test failing (a genuinely fresh, never-
 * used, correctly-generated code was rejected as invalid), traced back
 * to the ciphertext, not assumed. Same root cause class §3cc's own doc
 * comment already documents for `$queryRaw` specifically bypassing this
 * extension — an `include` across models hits the identical gap for a
 * different mechanical reason (extension scoping, not raw SQL).
 */
export async function adminFindUserById(userId: string) {
  const admin = createAdminClient();
  return admin.user.findUnique({ where: { id: userId } });
}

/**
 * Invalidates any still-open prior token for this user before creating a
 * new one — requesting a fresh reset/verification link makes any earlier,
 * still-unconsumed link stop working, rather than leaving multiple valid
 * tokens outstanding at once.
 */
export async function adminCreatePasswordResetToken(userId: string, tokenHash: string, expiresAt: Date) {
  const admin = createAdminClient();
  await admin.passwordResetToken.updateMany({
    where: { userId, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  return admin.passwordResetToken.create({ data: { userId, tokenHash, expiresAt } });
}

export async function adminFindPasswordResetTokenByHash(tokenHash: string) {
  const admin = createAdminClient();
  return admin.passwordResetToken.findUnique({ where: { tokenHash } });
}

/**
 * TOTP replay-protection bookkeeping for the reset flow (`password-reset.ts`'s
 * `confirmPasswordReset`) — identical persistence `checkTotpChallenge`
 * (`credentials.ts`) already does for login, just reachable from this
 * file instead, since `password-reset.ts` itself is not admin-client-
 * boundary-allowlisted and must go through here rather than importing
 * `createAdminClient` directly.
 */
export async function adminRecordTotpTimeStep(userId: string, timeStep: number) {
  const admin = createAdminClient();
  return admin.user.update({ where: { id: userId }, data: { totpLastUsedTimeStep: timeStep } });
}

/**
 * Marks the token consumed AND writes the new password hash, bumping
 * `tokenVersion` in the same call — a successful password reset is
 * exactly the kind of security-posture event `disableTotp` (`dal/mfa.ts`)
 * already treats as worth invalidating every OTHER outstanding session
 * for (a stolen/lost device that's still logged in elsewhere must not
 * silently survive its own password being reset out from under it).
 * Two sequential admin-client calls, not a wrapped `$transaction` — same
 * "sequential, not atomically wrapped" idiom `acceptGroupInvite` already
 * uses for its own two-call admin-client bootstrap sequence.
 */
export async function adminConsumePasswordResetToken(tokenId: string, userId: string, passwordHash: string) {
  const admin = createAdminClient();
  await admin.passwordResetToken.update({ where: { id: tokenId }, data: { consumedAt: new Date() } });
  return admin.user.update({
    where: { id: userId },
    data: { passwordHash, tokenVersion: { increment: 1 } },
  });
}

export async function adminCreateEmailVerificationToken(userId: string, tokenHash: string, expiresAt: Date) {
  const admin = createAdminClient();
  await admin.emailVerificationToken.updateMany({
    where: { userId, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  return admin.emailVerificationToken.create({ data: { userId, tokenHash, expiresAt } });
}

export async function adminFindEmailVerificationTokenByHash(tokenHash: string) {
  const admin = createAdminClient();
  // No `include: { user: true }` — this flow never reads a `User`
  // encrypted field, only `record.userId`, so there's no reason to risk
  // the same nested-relation-bypasses-the-encryption-extension trap
  // `adminFindPasswordResetTokenByHash`'s own doc comment documents,
  // even though it happens to be harmless here today.
  return admin.emailVerificationToken.findUnique({ where: { tokenHash } });
}

/** Confirming an email address is not a security-posture downgrade (the opposite, if anything) — deliberately does NOT bump tokenVersion, same reasoning `confirmTotpSetup` already documents for its own "no reason to force re-authentication" call. */
export async function adminConsumeEmailVerificationToken(tokenId: string, userId: string) {
  const admin = createAdminClient();
  await admin.emailVerificationToken.update({ where: { id: tokenId }, data: { consumedAt: new Date() } });
  return admin.user.update({ where: { id: userId }, data: { emailVerified: new Date() } });
}
