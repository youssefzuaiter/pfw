import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import {
  createAuthenticator,
  createRegistrationChallenge,
  consumeRegistrationChallenge,
  deleteAuthenticator,
  listAuthenticators,
  listCredentialIds,
  touchAuthenticatorLastUsed,
} from "../../src/server/dal/authenticators";
import {
  consumeAuthenticationChallenge,
  createAuthenticationChallenge,
  findAuthenticationCandidate,
  findAuthenticatorForVerification,
  recordSuccessfulAuthentication,
} from "../../src/server/auth/webauthn-admin-ops";

/**
 * Integration coverage for Device-Bound Biometrics via Passkeys (ad
 * hoc) — the DAL/admin-ops layer only, against real Postgres with RLS
 * active, same convention as every other integration suite in this
 * history. Deliberately does NOT attempt to simulate a full, real
 * WebAuthn cryptographic ceremony (a valid COSE public key, CBOR-encoded
 * attestation object, and a genuine ECDSA/RSA signature over it) — that
 * would need either a real authenticator or a hand-rolled crypto fixture
 * disproportionate to what this pass could responsibly build and verify;
 * flagged plainly rather than glossed over (the same honesty §3o's
 * untested-live-Ollama gap and §3dd's untested-live-WASM gap already
 * apply to a different kind of "can't fully verify in this environment"
 * limit). What IS covered here, for real: every DB read/write path
 * `@simplewebauthn/server`'s verification functions are wrapped around —
 * challenge issuance/single-use consumption, authenticator CRUD, and
 * cross-user IDOR isolation — using arbitrary dummy bytes for
 * `publicKey`/`credentialId`, since the DAL itself never inspects their
 * cryptographic validity, only stores and retrieves them.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("Device-Bound Biometrics via Passkeys", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let userA: { id: string; email: string };
  let userB: { id: string; email: string };

  beforeAll(async () => {
    admin = createAdminClient();
    userA = await admin.user.create({
      data: { email: `passkey-test-a-${Date.now()}@pfw.local`, displayName: "Passkey Test A" },
    });
    userB = await admin.user.create({
      data: { email: `passkey-test-b-${Date.now()}@pfw.local`, displayName: "Passkey Test B" },
    });
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    await admin.$disconnect();
  });

  function dummyPublicKey(seed: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(32);
    bytes.fill(seed % 256);
    return bytes;
  }

  describe("authenticator CRUD", () => {
    it("creates, lists (oldest first), and deletes an authenticator; IDOR-safe both ways", async () => {
      const credentialId = `cred-${Date.now()}-1`;
      await createAuthenticator(userA.id, {
        credentialId,
        publicKey: dummyPublicKey(1),
        counter: 0n,
        deviceType: "singleDevice",
        backedUp: false,
        transports: ["internal"],
        deviceLabel: "Test MacBook",
      });

      const listedAsA = await listAuthenticators(userA.id);
      expect(listedAsA).toHaveLength(1);
      expect(listedAsA[0].deviceLabel).toBe("Test MacBook");
      expect(listedAsA[0].deviceType).toBe("singleDevice");
      expect(listedAsA[0].backedUp).toBe(false);
      expect(listedAsA[0].transports).toEqual(["internal"]);

      // IDOR: userB never sees userA's authenticator.
      const listedAsB = await listAuthenticators(userB.id);
      expect(listedAsB).toHaveLength(0);

      // IDOR: userB cannot delete userA's authenticator.
      const deletedByB = await deleteAuthenticator(userB.id, listedAsA[0].id);
      expect(deletedByB).toBe(false);
      expect(await listAuthenticators(userA.id)).toHaveLength(1);

      // The real owner can.
      const deletedByA = await deleteAuthenticator(userA.id, listedAsA[0].id);
      expect(deletedByA).toBe(true);
      expect(await listAuthenticators(userA.id)).toHaveLength(0);
    });

    it("listCredentialIds returns only this user's own credential ids/transports", async () => {
      const credentialId = `cred-${Date.now()}-2`;
      await createAuthenticator(userA.id, {
        credentialId,
        publicKey: dummyPublicKey(2),
        counter: 0n,
        deviceType: "multiDevice",
        backedUp: true,
        transports: ["hybrid", "internal"],
        deviceLabel: "Test Phone",
      });

      const idsAsA = await listCredentialIds(userA.id);
      expect(idsAsA).toEqual([{ credentialId, transports: ["hybrid", "internal"] }]);
      expect(await listCredentialIds(userB.id)).toEqual([]);
    });

    it("touchAuthenticatorLastUsed updates counter and lastUsedAt", async () => {
      const credentialId = `cred-${Date.now()}-3`;
      await createAuthenticator(userA.id, {
        credentialId,
        publicKey: dummyPublicKey(3),
        counter: 0n,
        deviceType: "singleDevice",
        backedUp: false,
        transports: [],
        deviceLabel: "Touch Test",
      });
      const [created] = await listAuthenticators(userA.id);
      expect(created.lastUsedAt).toBeNull();

      await touchAuthenticatorLastUsed(userA.id, created.id, 5n);

      const row = await admin.authenticator.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.counter).toBe(5n);
      expect(row.lastUsedAt).not.toBeNull();
    });
  });

  describe("registration challenges", () => {
    it("issues a single-use challenge — consuming it twice returns the value once, then null", async () => {
      const challengeId = await createRegistrationChallenge(userA.id, "test-challenge-value");
      const first = await consumeRegistrationChallenge(userA.id, challengeId);
      expect(first).toBe("test-challenge-value");

      const second = await consumeRegistrationChallenge(userA.id, challengeId);
      expect(second).toBeNull();
    });

    it("IDOR: a registration challenge issued for userA cannot be consumed as userB", async () => {
      const challengeId = await createRegistrationChallenge(userA.id, "another-challenge");
      const asB = await consumeRegistrationChallenge(userB.id, challengeId);
      expect(asB).toBeNull();

      // Still consumable by the real owner afterward — userB's failed
      // attempt must not have silently deleted it.
      const asA = await consumeRegistrationChallenge(userA.id, challengeId);
      expect(asA).toBe("another-challenge");
    });

    it("rejects an expired challenge, and still consumes (deletes) it either way", async () => {
      const row = await admin.challenge.create({
        data: {
          userId: userA.id,
          type: "REGISTRATION",
          challenge: "expired-challenge",
          expiresAt: new Date(Date.now() - 1000),
        },
      });
      const result = await consumeRegistrationChallenge(userA.id, row.id);
      expect(result).toBeNull();

      // Consumed (deleted) despite being expired/rejected — no dangling row.
      const stillThere = await admin.challenge.findUnique({ where: { id: row.id } });
      expect(stillThere).toBeNull();
    });
  });

  describe("authentication candidate lookup (pre-auth admin bootstrap)", () => {
    it("returns null for an email with no account at all", async () => {
      expect(await findAuthenticationCandidate(`no-such-user-${Date.now()}@pfw.local`)).toBeNull();
    });

    it("returns null for a real account with zero registered passkeys", async () => {
      expect(await findAuthenticationCandidate(userB.email)).toBeNull();
    });

    it("returns the candidate with their registered credential ids for a real account with passkeys", async () => {
      const credentialId = `cred-${Date.now()}-auth`;
      await createAuthenticator(userA.id, {
        credentialId,
        publicKey: dummyPublicKey(4),
        counter: 0n,
        deviceType: "singleDevice",
        backedUp: false,
        transports: ["internal"],
        deviceLabel: "Auth Candidate Device",
      });

      const candidate = await findAuthenticationCandidate(userA.email);
      expect(candidate).not.toBeNull();
      expect(candidate?.userId).toBe(userA.id);
      expect(candidate?.credentials.map((c) => c.credentialId)).toContain(credentialId);
    });
  });

  describe("authentication challenges (pre-auth admin bootstrap)", () => {
    it("issues a single-use challenge, scoped to userId+type, IDOR-safe", async () => {
      const challengeId = await createAuthenticationChallenge(userA.id, "auth-challenge-value");

      const asB = await consumeAuthenticationChallenge(userB.id, challengeId);
      expect(asB).toBeNull();

      const asA = await consumeAuthenticationChallenge(userA.id, challengeId);
      expect(asA).toBe("auth-challenge-value");

      // Single-use — a second attempt by the real owner also fails now.
      expect(await consumeAuthenticationChallenge(userA.id, challengeId)).toBeNull();
    });
  });

  describe("findAuthenticatorForVerification / recordSuccessfulAuthentication", () => {
    it("resolves an authenticator only for the SAME userId the challenge was issued for", async () => {
      const credentialId = `cred-${Date.now()}-verify`;
      await createAuthenticator(userA.id, {
        credentialId,
        publicKey: dummyPublicKey(5),
        counter: 0n,
        deviceType: "singleDevice",
        backedUp: false,
        transports: [],
        deviceLabel: "Verify Test Device",
      });

      const wrongUser = await findAuthenticatorForVerification(userB.id, credentialId);
      expect(wrongUser).toBeNull();

      const correct = await findAuthenticatorForVerification(userA.id, credentialId);
      expect(correct).not.toBeNull();
      expect(correct?.counter).toBe(0n);

      await recordSuccessfulAuthentication(correct!.id, 42n);
      const updated = await admin.authenticator.findUniqueOrThrow({ where: { id: correct!.id } });
      expect(updated.counter).toBe(42n);
      expect(updated.lastUsedAt).not.toBeNull();
    });
  });
});
