import "server-only";
import { createHash, randomBytes } from "node:crypto";

/**
 * MFA backup codes (Phase 3, Security & Recovery) — pure generation/
 * hashing helpers, no DB access, same split `totp.ts` already establishes
 * for TOTP (crypto here, persistence in `dal/recovery-codes.ts` for the
 * authenticated generation path and `recovery-code-admin-ops.ts` for the
 * unauthenticated redemption path).
 */

export const RECOVERY_CODE_COUNT = 8;
const RAW_BYTES_PER_CODE = 6; // 48 bits of entropy per code — each is independently strong; a used code is marked used, so there's no replay to compound across the 8.

/** Human-typable: 12 lowercase hex chars, grouped for readability (e.g. "a1b2c3-d4e5f6"). */
export function generateRecoveryCode(): string {
  const hex = randomBytes(RAW_BYTES_PER_CODE).toString("hex");
  return `${hex.slice(0, 6)}-${hex.slice(6, 12)}`;
}

export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, generateRecoveryCode);
}

/** Same SHA-256-hex convention as every other "hash it, never store the secret" token in this app (password-reset.ts, email-verification.ts, recovery-service.ts). Normalizes case/whitespace first so a user re-typing a code by hand (rather than pasting it) isn't rejected over incidental formatting. */
export function hashRecoveryCode(rawCode: string): string {
  const normalized = rawCode.trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}
