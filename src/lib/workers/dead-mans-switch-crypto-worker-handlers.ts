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

export type DmsCryptoHandlers = {
  setup(payload: {
    passphrase: string;
    iterations: number;
    totalShares: number;
    thresholdShares: number;
  }): Promise<{ salt: string; canaryCiphertext: string; shares: { index: number; encodedShare: string; shareHash: string }[] }>;
  unlock(payload: {
    passphrase: string;
    saltBase64: string;
    iterations: number;
    canaryCiphertext: string;
  }): Promise<{ valid: boolean }>;
  lock(): { locked: true };
  encrypt(payload: { plaintext: string }): Promise<{ ciphertext: string }>;
  decrypt(payload: { ciphertext: string }): Promise<{ plaintext: string }>;
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
  };
}
