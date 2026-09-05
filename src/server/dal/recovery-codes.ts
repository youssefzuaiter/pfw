import "server-only";
import { withUserScope } from "../db/with-user-scope";
import { generateRecoveryCodes, hashRecoveryCode } from "../auth/recovery-codes";

/**
 * DAL for `RecoveryCode` generation (Phase 3, Security & Recovery). Every
 * call here already has an authenticated `userId` from `guardMutation()`
 * upstream (an MFA enrollment action), so — unlike the redemption path in
 * `recovery-code-admin-ops.ts` (called from inside `authorize()`, before
 * any session exists) — this goes through the normal `withUserScope`-
 * scoped runtime client, same as every other DAL module.
 */

async function hasUnusedRecoveryCodes(userId: string): Promise<boolean> {
  const count = await withUserScope(userId, (tx) => tx.recoveryCode.count({ where: { userId, used: false } }));
  return count > 0;
}

/**
 * Generates and stores a fresh batch of 8 codes ONLY when the user has
 * none left unused — called from BOTH the TOTP confirm flow and the
 * WebAuthn passkey registration flow ("upon successful MFA setup"), so
 * whichever one happens first is what actually issues codes; the other
 * finds unused codes already present and returns `null` (nothing new to
 * show), rather than silently invalidating a batch the user already saved
 * every time a second factor/device is added. Returns the RAW codes —
 * the one and only time they ever exist outside a user's own device; only
 * their hashes are persisted.
 */
export async function ensureRecoveryCodes(userId: string): Promise<string[] | null> {
  if (await hasUnusedRecoveryCodes(userId)) return null;

  const rawCodes = generateRecoveryCodes();
  const hashes = rawCodes.map(hashRecoveryCode);
  await withUserScope(userId, (tx) =>
    tx.recoveryCode.createMany({ data: hashes.map((codeHash) => ({ userId, codeHash })) }),
  );
  return rawCodes;
}
