/**
 * The actual request handlers `zk-crypto.worker.ts` serves (AGENTS.md
 * §3m, §3x) — split into its own module, with no top-level
 * `self`/`postMessage` reference of its own, specifically so it can be
 * imported and exercised directly in a test (see
 * `tests/integration/web-worker-rpc.test.ts`) without needing a real
 * Worker global, which neither of this project's test environments
 * (Node, jsdom) provides. `zk-crypto.worker.ts` itself stays a thin,
 * untested-by-necessity one-liner that wires this factory's output up to
 * the real worker's message channel — see that file's own doc comment
 * for the actual security rationale.
 */

import { deriveZkKey, decryptWithZkKey, encryptWithZkKey, verifyZkKey, ZK_CANARY_PLAINTEXT } from "../zk-crypto";

export type ZkCryptoHandlers = {
  setup(payload: { passphrase: string; saltBase64: string; iterations: number }): Promise<{ canaryCiphertext: string }>;
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

/** One fresh, independent `activeKey` closure per call — a real worker only ever calls this once (module top level), but tests can call it repeatedly for isolated instances. */
export function createZkCryptoHandlers(): ZkCryptoHandlers {
  let activeKey: CryptoKey | null = null;

  function requireActiveKey(): CryptoKey {
    if (!activeKey) throw new Error("Zero-knowledge vault is locked");
    return activeKey;
  }

  return {
    async setup(payload) {
      const key = await deriveZkKey(payload.passphrase, payload.saltBase64, payload.iterations);
      const canaryCiphertext = await encryptWithZkKey(key, ZK_CANARY_PLAINTEXT);
      activeKey = key;
      return { canaryCiphertext };
    },

    async unlock(payload) {
      const candidate = await deriveZkKey(payload.passphrase, payload.saltBase64, payload.iterations);
      const valid = await verifyZkKey(candidate, payload.canaryCiphertext);
      if (valid) activeKey = candidate;
      return { valid };
    },

    lock() {
      activeKey = null;
      return { locked: true };
    },

    async encrypt(payload) {
      return { ciphertext: await encryptWithZkKey(requireActiveKey(), payload.plaintext) };
    },

    async decrypt(payload) {
      return { plaintext: await decryptWithZkKey(requireActiveKey(), payload.ciphertext) };
    },
  };
}
