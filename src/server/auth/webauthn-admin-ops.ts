import "server-only";
import { createAdminClient } from "../db/admin-client";
import { CHALLENGE_TTL_MS } from "./webauthn";

/**
 * Device-Bound Biometrics via Passkeys (ad hoc) — the FIFTH narrow,
 * allowlisted admin-client bootstrap exception, same justification every
 * prior one shares (`current-user.ts`, the household/vault invite flows,
 * `credentials.ts`, `account-recovery-admin-ops.ts`): a passkey SIGN-IN
 * attempt is, by definition, unauthenticated — there is no `userId` yet
 * to scope a normal `withUserScope` call by until the assertion has
 * actually been verified. Registering a NEW passkey (an already-
 * authenticated user, from Settings) has no such problem and goes through
 * the ordinary `withUserScope`-scoped DAL instead
 * (`src/server/dal/authenticators.ts`). See
 * tests/guards/admin-client-boundary.test.ts.
 */

export type AuthenticationCandidate = {
  userId: string;
  email: string;
  displayName: string;
  tokenVersion: number;
  credentials: { credentialId: string; transports: string[] }[];
};

/**
 * `null` for an unknown email OR one with zero registered passkeys —
 * treated identically, same enumeration-safety shape `verifyCredentials`
 * already establishes for password login (Section 2.2's "never reveal
 * whether an account exists" applied here to "whether it has a passkey").
 */
export async function findAuthenticationCandidate(email: string): Promise<AuthenticationCandidate | null> {
  const admin = createAdminClient();
  const user = await admin.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      displayName: true,
      tokenVersion: true,
      authenticators: { select: { credentialId: true, transports: true } },
    },
  });
  if (!user || user.authenticators.length === 0) return null;

  return {
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    tokenVersion: user.tokenVersion,
    credentials: user.authenticators,
  };
}

export async function createAuthenticationChallenge(userId: string, challenge: string): Promise<string> {
  const admin = createAdminClient();
  const row = await admin.challenge.create({
    data: { userId, type: "AUTHENTICATION", challenge, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) },
  });
  return row.id;
}

/**
 * Single-use, same "delete on read, whether or not verification then
 * succeeds" shape `consumeRegistrationChallenge` uses — scoped to BOTH
 * the challenge id AND the userId the authentication attempt claims to
 * be for, so a challenge issued for one user can never be redeemed
 * against a different user's authenticator (an IDOR this table's own RLS
 * policy would also catch under a normal session, but this path runs
 * before one exists, so the check has to be explicit here).
 */
export async function consumeAuthenticationChallenge(userId: string, challengeId: string): Promise<string | null> {
  const admin = createAdminClient();
  const row = await admin.challenge.findFirst({ where: { id: challengeId, userId, type: "AUTHENTICATION" } });
  if (!row) return null;
  await admin.challenge.delete({ where: { id: row.id } });
  if (row.expiresAt < new Date()) return null;
  return row.challenge;
}

export type StoredAuthenticator = {
  id: string;
  publicKey: Uint8Array;
  counter: bigint;
  transports: string[];
};

/** Scoped to the SAME userId the challenge was issued for — never a bare global lookup by credentialId alone, which would let a correctly-signed assertion for user A's own credential be checked against a challenge issued for user B. */
export async function findAuthenticatorForVerification(userId: string, credentialId: string): Promise<StoredAuthenticator | null> {
  const admin = createAdminClient();
  const row = await admin.authenticator.findFirst({ where: { userId, credentialId } });
  if (!row) return null;
  return { id: row.id, publicKey: row.publicKey, counter: row.counter, transports: row.transports };
}

export async function recordSuccessfulAuthentication(authenticatorId: string, counter: bigint): Promise<void> {
  const admin = createAdminClient();
  await admin.authenticator.update({ where: { id: authenticatorId }, data: { counter, lastUsedAt: new Date() } });
}
