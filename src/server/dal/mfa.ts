import "server-only";
import { withUserScope } from "../db/with-user-scope";
import { buildOtpauthUri, generateTotpSecret, verifyTotpCode } from "../auth/totp";
import { bumpTokenVersion } from "../auth/token-version";

/**
 * DAL for TOTP MFA setup/confirm/disable (Punch List Tier 2, item 3).
 * Every call here already has an authenticated `userId` from
 * `guardMutation()` upstream, so — unlike `credentials.ts`'s
 * `checkTotpChallenge` (called from inside `authorize()`, before any
 * session exists) — these go through the normal `withUserScope`-scoped
 * runtime client, same as every other DAL module.
 */

export type MfaStatus = { enabled: boolean; pending: boolean };

/**
 * `pending`: a secret has been generated (setup started) but never
 * confirmed with a correct code — real, load-bearing state distinct from
 * `enabled`, the same way `User.passwordHash === null` is load-bearing
 * for an unclaimed seeded row (§3ff). Lets the settings UI show "finish
 * setting up MFA" instead of either a blank state or a false "enabled."
 */
export async function getMfaStatus(userId: string): Promise<MfaStatus> {
  const user = await withUserScope(userId, (tx) =>
    tx.user.findUnique({ where: { id: userId }, select: { totpEnabled: true, totpSecret: true } }),
  );
  return { enabled: user?.totpEnabled ?? false, pending: !user?.totpEnabled && user?.totpSecret != null };
}

export type BeginTotpSetupResult = { secret: string; otpauthUri: string };

/**
 * Overwrites any previous (unconfirmed OR confirmed) secret unconditionally
 * — restarting setup is always safe here, unlike the zero-knowledge
 * vault's one-time-only `setupZkVault` (§3m): nothing is ever encrypted
 * under a TOTP secret the way notes are encrypted under the zk-vault key,
 * so there's no data that a new secret could orphan. Re-running setup on
 * an ALREADY-enabled account does correctly leave `totpEnabled: true`
 * until `confirmTotpSetup` is called again — an authenticator app scan
 * with no confirmation must never silently disable existing protection.
 */
export async function beginTotpSetup(userId: string, accountEmail: string): Promise<BeginTotpSetupResult> {
  const secret = generateTotpSecret();
  await withUserScope(userId, (tx) =>
    tx.user.update({ where: { id: userId }, data: { totpSecret: secret, totpLastUsedTimeStep: null } }),
  );
  return { secret, otpauthUri: buildOtpauthUri(secret, accountEmail) };
}

export type ConfirmTotpSetupResult = { ok: true } | { ok: false; error: "no_pending_setup" | "invalid_code" };

/**
 * Proves possession of a working authenticator app before flipping
 * `totpEnabled` — see `User.totpEnabled`'s own schema doc comment for why
 * that ordering matters. Deliberately does NOT bump tokenVersion: raising
 * this account's security posture has no reason to force other, already-
 * legitimate sessions to re-authenticate (unlike `disableTotp` below).
 */
export async function confirmTotpSetup(userId: string, code: string): Promise<ConfirmTotpSetupResult> {
  return withUserScope(userId, async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { totpSecret: true, totpLastUsedTimeStep: true },
    });
    if (!user?.totpSecret) return { ok: false, error: "no_pending_setup" };

    const result = await verifyTotpCode(user.totpSecret, code, user.totpLastUsedTimeStep);
    if (!result.valid) return { ok: false, error: "invalid_code" };

    await tx.user.update({
      where: { id: userId },
      data: { totpEnabled: true, totpLastUsedTimeStep: result.timeStep },
    });
    return { ok: true };
  });
}

/**
 * Disabling MFA is a real security-posture downgrade, so — unlike
 * confirming setup — this bumps tokenVersion, forcing every OTHER
 * outstanding session (a lost/stolen device that's still logged in
 * elsewhere) to re-authenticate rather than silently continuing under
 * the now-weaker factor requirement.
 */
export async function disableTotp(userId: string): Promise<void> {
  await withUserScope(userId, (tx) =>
    tx.user.update({
      where: { id: userId },
      data: { totpSecret: null, totpEnabled: false, totpLastUsedTimeStep: null },
    }),
  );
  await bumpTokenVersion(userId);
}
