import "server-only";
import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import { getAppUrl } from "../env";
import { sendPasswordResetEmail } from "../email/auth-emails";
import { verifyTotpCode } from "./totp";
import {
  adminConsumePasswordResetToken,
  adminCreatePasswordResetToken,
  adminFindPasswordResetTokenByHash,
  adminFindUserByEmail,
  adminFindUserById,
  adminRecordTotpTimeStep,
} from "./account-recovery-admin-ops";

/**
 * ASVS-aligned password reset (auth hardening pass, ad hoc post-§3ff):
 * a cryptographically random, single-use, 15-minute token emailed as a
 * link — never predictable data like a base64-encoded email. If the
 * account has TOTP enabled, the code is required to complete the reset
 * (never a KBA/security-question fallback, which this app never had to
 * begin with — see the design discussion this pass started from).
 */

const RAW_TOKEN_BYTES = 32;
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Always resolves with no distinguishing outcome the caller can observe
 * — a nonexistent email, an unclaimed seeded row (no password to reset),
 * and a real send failure all fall through to this function simply
 * returning, same as a genuine success. The route handler on top of this
 * always returns the identical generic "If an account exists…" message
 * regardless — this is what makes that uniformity actually hold even
 * under a Resend outage, not just when every step happens to succeed.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await adminFindUserByEmail(email);
  if (!user || !user.passwordHash) return;

  const rawToken = randomBytes(RAW_TOKEN_BYTES).toString("base64url");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  await adminCreatePasswordResetToken(user.id, tokenHash, expiresAt);

  const resetUrl = `${getAppUrl()}/reset-password/${rawToken}`;
  try {
    await sendPasswordResetEmail(user.email, resetUrl);
  } catch (error) {
    // Logged, never rethrown — see this function's own doc comment above
    // for why a Resend outage must not change what the caller observes.
    console.error("requestPasswordReset: sendPasswordResetEmail failed", error);
  }
}

export type ConfirmPasswordResetResult =
  | { ok: true }
  | { ok: false; error: "invalid_or_expired" | "totp_required" | "totp_invalid" };

export async function confirmPasswordReset(
  rawToken: string,
  newPassword: string,
  totpCode: string | undefined,
): Promise<ConfirmPasswordResetResult> {
  const tokenHash = hashToken(rawToken);
  const record = await adminFindPasswordResetTokenByHash(tokenHash);
  if (!record || record.consumedAt || record.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: "invalid_or_expired" };
  }

  // A SEPARATE `admin.user.findUnique` call, not `record.user` from an
  // `include` — see `adminFindUserById`'s own doc comment for the real
  // bug that shape caused (a raw-ciphertext `totpSecret` silently
  // rejecting every genuinely valid code).
  const user = await adminFindUserById(record.userId);
  if (!user) return { ok: false, error: "invalid_or_expired" };

  if (user.totpEnabled && user.totpSecret) {
    if (!totpCode) return { ok: false, error: "totp_required" };
    const verification = await verifyTotpCode(user.totpSecret, totpCode, user.totpLastUsedTimeStep);
    if (!verification.valid) return { ok: false, error: "totp_invalid" };
    await adminRecordTotpTimeStep(user.id, verification.timeStep);
  }

  const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
  await adminConsumePasswordResetToken(record.id, user.id, passwordHash);
  return { ok: true };
}
