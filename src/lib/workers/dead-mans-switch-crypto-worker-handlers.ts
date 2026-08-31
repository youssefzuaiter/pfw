/**
 * The actual request handlers `dead-mans-switch-crypto.worker.ts` serves
 * (AGENTS.md §3t, §3x) — split into its own module for the same reason as
 * `zk-crypto-worker-handlers.ts`: no top-level `self`/`postMessage`
 * reference, so it can be imported and exercised directly in
 * `tests/integration/web-worker-rpc.test.ts` without a real Worker
 * global.
 */

import {
  DMS_CANARY_PLAINTEXT,
  decryptVaultValue,
  deriveVaultKeyBytes,
  encryptVaultValue,
  generateVaultSalt,
  importVaultAesKey,
  verifyVaultKey,
} from "../dead-mans-switch-crypto";
import { encodeShare, splitSecret } from "../shamir-secret-sharing";

type EncodedShare = { index: number; encodedShare: string; shareHash: string };

export type DmsCryptoHandlers = {
  setup(payload: {
    passphrase: string;
    iterations: number;
    totalShares: number;
    thresholdShares: number;
  }): Promise<{ salt: string; canaryCiphertext: string; shares: EncodedShare[] }>;
  unlock(payload: {
    passphrase: string;
    saltBase64: string;
    iterations: number;
    canaryCiphertext: string;
  }): Promise<{ valid: boolean }>;
  lock(): { locked: true };
  encrypt(payload: { plaintext: string }): Promise<{ ciphertext: string }>;
  decrypt(payload: { ciphertext: string }): Promise<{ plaintext: string }>;
  /**
   * Dynamic Beneficiaries (AGENTS.md §3t amendment, item 2): re-splits
   * the EXISTING master key under a NEW total/threshold share
   * configuration, without touching the key itself or any
   * EmergencyDocument — see this file's own doc comment for why the
   * owner must re-enter their CURRENT passphrase for this operation
   * (the previously-imported `activeKey` from `unlock`/`setup` is
   * non-extractable by construction, so there is no way to get the raw
   * bytes `splitSecret` needs back out of it; re-deriving them fresh
   * from the still-known salt/iterations + a freshly-entered passphrase
   * is the only path, and it doubles as a re-confirmation that the
   * caller genuinely knows the passphrase before the share set changes).
   */
  resplit(payload: {
    passphrase: string;
    saltBase64: string;
    iterations: number;
    canaryCiphertext: string;
    totalShares: number;
    thresholdShares: number;
  }): Promise<{ valid: true; shares: EncodedShare[] } | { valid: false }>;
  /**
   * Passphrase Rotation, Emergency Vault half (AGENTS.md §3t amendment,
   * item 1): verifies the OLD passphrase, decrypts every existing
   * EmergencyDocument with the OLD key, derives a fresh salt + NEW key
   * from the NEW passphrase, re-encrypts every document under the NEW
   * key, and re-splits the NEW key into shares — all inside this one
   * worker call, so plaintext document content and both keys' raw bytes
   * never cross back to the main thread at any point. `totalShares`/
   * `thresholdShares` are carried over unchanged (a pure rotation keeps
   * the same beneficiary count; changing it is `resplit`'s job) but are
   * still required here rather than read from the caller's existing
   * config, so this function has no implicit dependency on state the
   * worker doesn't actually hold.
   */
  rotate(payload: {
    oldPassphrase: string;
    oldSaltBase64: string;
    oldIterations: number;
    oldCanaryCiphertext: string;
    newPassphrase: string;
    newIterations: number;
    totalShares: number;
    thresholdShares: number;
    documents: { id: string; ciphertext: string }[];
  }): Promise<
    | {
        valid: true;
        newSalt: string;
        newCanaryCiphertext: string;
        documents: { id: string; ciphertext: string }[];
        shares: EncodedShare[];
      }
    | { valid: false }
  >;
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** One fresh, independent `activeKey` closure per call — see `createZkCryptoHandlers`'s doc comment for why. */
export function createDmsCryptoHandlers(): DmsCryptoHandlers {
  let activeKey: CryptoKey | null = null;

  function requireActiveKey(): CryptoKey {
    if (!activeKey) throw new Error("Emergency Vault is locked");
    return activeKey;
  }

  return {
    async setup(payload) {
      const salt = generateVaultSalt();
      const rawKey = await deriveVaultKeyBytes(payload.passphrase, salt, payload.iterations);

      const key = await importVaultAesKey(rawKey);
      const canaryCiphertext = await encryptVaultValue(key, DMS_CANARY_PLAINTEXT);
      const rawShares = splitSecret(rawKey, payload.totalShares, payload.thresholdShares);

      rawKey.fill(0); // Best-effort: nothing below this line still needs it.
      activeKey = key;

      const shares = await Promise.all(
        rawShares.map(async (share) => ({
          index: share.index,
          encodedShare: encodeShare(share),
          shareHash: await sha256Hex(share.value),
        })),
      );

      return { salt, canaryCiphertext, shares };
    },

    async unlock(payload) {
      const rawKey = await deriveVaultKeyBytes(payload.passphrase, payload.saltBase64, payload.iterations);
      const candidate = await importVaultAesKey(rawKey);
      rawKey.fill(0);

      const valid = await verifyVaultKey(candidate, payload.canaryCiphertext);
      if (valid) activeKey = candidate;
      return { valid };
    },

    lock() {
      activeKey = null;
      return { locked: true };
    },

    async encrypt(payload) {
      return { ciphertext: await encryptVaultValue(requireActiveKey(), payload.plaintext) };
    },

    async decrypt(payload) {
      return { plaintext: await decryptVaultValue(requireActiveKey(), payload.ciphertext) };
    },

    async resplit(payload) {
      const rawKey = await deriveVaultKeyBytes(payload.passphrase, payload.saltBase64, payload.iterations);
      const candidate = await importVaultAesKey(rawKey);

      const valid = await verifyVaultKey(candidate, payload.canaryCiphertext);
      if (!valid) {
        rawKey.fill(0);
        return { valid: false };
      }

      const rawShares = splitSecret(rawKey, payload.totalShares, payload.thresholdShares);
      rawKey.fill(0); // Best-effort: nothing below this line still needs it.
      activeKey = candidate;

      const shares = await Promise.all(
        rawShares.map(async (share) => ({
          index: share.index,
          encodedShare: encodeShare(share),
          shareHash: await sha256Hex(share.value),
        })),
      );

      return { valid: true, shares };
    },

    async rotate(payload) {
      const oldRawKey = await deriveVaultKeyBytes(payload.oldPassphrase, payload.oldSaltBase64, payload.oldIterations);
      const oldKey = await importVaultAesKey(oldRawKey);
      oldRawKey.fill(0);

      const oldKeyValid = await verifyVaultKey(oldKey, payload.oldCanaryCiphertext);
      if (!oldKeyValid) {
        return { valid: false };
      }

      const decryptedDocuments = await Promise.all(
        payload.documents.map(async (document) => ({
          id: document.id,
          plaintext: await decryptVaultValue(oldKey, document.ciphertext),
        })),
      );

      const newSalt = generateVaultSalt();
      const newRawKey = await deriveVaultKeyBytes(payload.newPassphrase, newSalt, payload.newIterations);
      const newKey = await importVaultAesKey(newRawKey);
      const newCanaryCiphertext = await encryptVaultValue(newKey, DMS_CANARY_PLAINTEXT);

      const reencryptedDocuments = await Promise.all(
        decryptedDocuments.map(async (document) => ({
          id: document.id,
          ciphertext: await encryptVaultValue(newKey, document.plaintext),
        })),
      );

      const rawShares = splitSecret(newRawKey, payload.totalShares, payload.thresholdShares);
      newRawKey.fill(0); // Best-effort: nothing below this line still needs it.
      activeKey = newKey;

      const shares = await Promise.all(
        rawShares.map(async (share) => ({
          index: share.index,
          encodedShare: encodeShare(share),
          shareHash: await sha256Hex(share.value),
        })),
      );

      return { valid: true, newSalt, newCanaryCiphertext, documents: reencryptedDocuments, shares };
    },
  };
}
