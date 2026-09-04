import "server-only";
import { withUserScope } from "../db/with-user-scope";
import { CHALLENGE_TTL_MS } from "../auth/webauthn";

/**
 * Device-Bound Biometrics via Passkeys (ad hoc) — the AUTHENTICATED-user
 * half of the DAL: registering a new passkey and managing existing ones,
 * all normal `withUserScope`-scoped operations, since a real session
 * already exists for every caller here (Settings, while logged in). The
 * pre-authentication half (looking a user up by email, issuing an
 * AUTHENTICATION challenge, verifying a sign-in assertion) lives in
 * `src/server/auth/webauthn-admin-ops.ts` instead — the same "bootstrap
 * problem, admin-client exception" shape `credentials.ts` already
 * establishes, since none of that can be scoped by a `userId` that
 * doesn't exist yet.
 */

export type AuthenticatorSummary = {
  id: string;
  deviceLabel: string;
  deviceType: string;
  backedUp: boolean;
  transports: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
};

export async function listAuthenticators(userId: string): Promise<AuthenticatorSummary[]> {
  const rows = await withUserScope(userId, (tx) =>
    tx.authenticator.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
  );
  return rows.map((row) => ({
    id: row.id,
    deviceLabel: row.deviceLabel,
    deviceType: row.deviceType,
    backedUp: row.backedUp,
    transports: row.transports,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  }));
}

/** For populating `excludeCredentials` when generating registration options — a user shouldn't be offered to register the same authenticator twice. */
export async function listCredentialIds(userId: string): Promise<{ credentialId: string; transports: string[] }[]> {
  return withUserScope(userId, (tx) =>
    tx.authenticator.findMany({ where: { userId }, select: { credentialId: true, transports: true } }),
  );
}

export type NewAuthenticator = {
  credentialId: string;
  /** Must be `Uint8Array<ArrayBuffer>` specifically — see `base64UrlToUint8Array`'s doc comment (`webauthn.ts`) for why the looser `Uint8Array<ArrayBufferLike>` a plain conversion would infer doesn't satisfy Prisma's generated `Bytes` input type. */
  publicKey: Uint8Array<ArrayBuffer>;
  counter: bigint;
  deviceType: string;
  backedUp: boolean;
  transports: string[];
  deviceLabel: string;
};

export async function createAuthenticator(userId: string, input: NewAuthenticator): Promise<void> {
  await withUserScope(userId, (tx) => tx.authenticator.create({ data: { userId, ...input } }));
}

/** `null` covers both "doesn't exist" and "belongs to someone else" — same IDOR shape as every other delete in this app (Section 2.2). */
export async function deleteAuthenticator(userId: string, id: string): Promise<boolean> {
  const result = await withUserScope(userId, (tx) => tx.authenticator.deleteMany({ where: { id, userId } }));
  return result.count > 0;
}

/**
 * Registration challenges are scoped to the ALREADY-authenticated caller
 * — a real `userId`-scoped `withUserScope` write, unlike the
 * authentication-challenge path in `webauthn-admin-ops.ts`.
 */
export async function createRegistrationChallenge(userId: string, challenge: string): Promise<string> {
  const row = await withUserScope(userId, (tx) =>
    tx.challenge.create({
      data: { userId, type: "REGISTRATION", challenge, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) },
    }),
  );
  return row.id;
}

/**
 * Single-use: the row is deleted the moment it's read here, whether or
 * not the caller goes on to successfully verify against it — a
 * registration ceremony gets exactly one attempt per issued challenge,
 * same "consume once, never replay" shape as `PasswordResetToken`.
 * Returns `null` for a missing, expired, or wrong-type/wrong-user
 * challenge — all treated identically, no distinguishing signal.
 */
export async function consumeRegistrationChallenge(userId: string, challengeId: string): Promise<string | null> {
  return withUserScope(userId, async (tx) => {
    const row = await tx.challenge.findFirst({ where: { id: challengeId, userId, type: "REGISTRATION" } });
    if (!row) return null;
    await tx.challenge.delete({ where: { id: row.id } });
    if (row.expiresAt < new Date()) return null;
    return row.challenge;
  });
}

export async function touchAuthenticatorLastUsed(userId: string, authenticatorId: string, counter: bigint): Promise<void> {
  await withUserScope(userId, (tx) =>
    tx.authenticator.update({ where: { id: authenticatorId }, data: { counter, lastUsedAt: new Date() } }),
  );
}
