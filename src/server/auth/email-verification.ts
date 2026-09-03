import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { getAppUrl } from "../env";
import { sendVerificationEmail } from "../email/auth-emails";
import {
  adminConsumeEmailVerificationToken,
  adminCreateEmailVerificationToken,
  adminFindEmailVerificationTokenByHash,
} from "./account-recovery-admin-ops";

/**
 * Email verification (auth hardening pass, ad hoc post-§3ff) — same
 * token shape/hashing as password-reset.ts, longer expiry (24h, matching
 * this app's own household-invite precedent's "not a security-sensitive-
 * enough action to need a 15-minute window" judgment — confirming an
 * inbox is lower-stakes than authorizing a credential change).
 */

const RAW_TOKEN_BYTES = 32;
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Called both right after registration and from the settings page's
 * "resend verification email" action — both call sites already have a
 * real `userId`/`email` in hand (a fresh registration or an authenticated
 * session), so unlike `requestPasswordReset` this never needs to guess
 * whether an account exists.
 */
export async function sendEmailVerification(userId: string, email: string): Promise<void> {
  const rawToken = randomBytes(RAW_TOKEN_BYTES).toString("base64url");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);
  await adminCreateEmailVerificationToken(userId, tokenHash, expiresAt);

  const verifyUrl = `${getAppUrl()}/verify-email/${rawToken}`;
  try {
    await sendVerificationEmail(email, verifyUrl);
  } catch (error) {
    // Logged, not rethrown — registration and the resend action both
    // still succeed even if the email itself failed to send; the user
    // can always hit "resend" again from settings.
    console.error("sendEmailVerification: sendVerificationEmail failed", error);
  }
}

export type ConfirmEmailVerificationResult = { ok: true } | { ok: false; error: "invalid_or_expired" };

export async function confirmEmailVerification(rawToken: string): Promise<ConfirmEmailVerificationResult> {
  const tokenHash = hashToken(rawToken);
  const record = await adminFindEmailVerificationTokenByHash(tokenHash);
  if (!record || record.consumedAt || record.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: "invalid_or_expired" };
  }

  await adminConsumeEmailVerificationToken(record.id, record.userId);
  return { ok: true };
}
