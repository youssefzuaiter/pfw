/**
 * Main-thread handle to `dead-mans-switch-crypto.worker.ts` (AGENTS.md
 * §3x) — same shape and same reasoning as `zk-vault-worker-client.ts`:
 * payloads in, payloads out, the worker itself never sends back the raw
 * master key, the imported `CryptoKey`, or a raw (un-encoded) Shamir
 * share value.
 *
 * One worker per browser tab, lazily constructed on first use.
 */

import { createRpcClient, type RpcCall } from "./worker-rpc";

let worker: Worker | null = null;
let call: RpcCall | null = null;

function getCall(): RpcCall {
  if (!call) {
    worker = new Worker(new URL("./dead-mans-switch-crypto.worker.ts", import.meta.url), { type: "module" });
    call = createRpcClient(worker);
  }
  return call;
}

export type DmsShare = { index: number; encodedShare: string; shareHash: string };

/**
 * Generates a fresh salt, derives the vault master key from `passphrase`,
 * activates it, splits it into `totalShares` shares (`thresholdShares` of
 * which reconstruct it), and returns everything needed to set up the
 * vault server-side EXCEPT the master key itself, which never leaves the
 * worker.
 */
export function dmsVaultSetup(
  passphrase: string,
  iterations: number,
  totalShares: number,
  thresholdShares: number,
): Promise<{ salt: string; canaryCiphertext: string; shares: DmsShare[] }> {
  return getCall()("setup", { passphrase, iterations, totalShares, thresholdShares });
}

/** Derives a candidate key from `passphrase`/`saltBase64` and verifies it against `canaryCiphertext`; activates it only on success. */
export function dmsVaultUnlock(
  passphrase: string,
  saltBase64: string,
  iterations: number,
  canaryCiphertext: string,
): Promise<{ valid: boolean }> {
  return getCall()("unlock", { passphrase, saltBase64, iterations, canaryCiphertext });
}

/** Discards the active key. */
export function dmsVaultLock(): Promise<{ locked: true }> {
  return getCall()("lock", {});
}

export function dmsVaultEncrypt(plaintext: string): Promise<{ ciphertext: string }> {
  return getCall()("encrypt", { plaintext });
}

export function dmsVaultDecrypt(ciphertext: string): Promise<{ plaintext: string }> {
  return getCall()("decrypt", { ciphertext });
}

/**
 * Dynamic Beneficiaries (AGENTS.md §3t amendment, item 2) — re-splits
 * the existing master key under a new total/threshold configuration
 * after re-verifying `passphrase` against the vault's existing
 * salt/iterations/canary. Every existing beneficiary's share becomes
 * invalid the moment this succeeds (a re-split is a fresh polynomial),
 * even for a beneficiary whose slot didn't otherwise change — the
 * caller is expected to persist ALL returned shares against the new
 * roster, not just the ones for added/removed beneficiaries.
 */
export function dmsVaultResplit(
  passphrase: string,
  saltBase64: string,
  iterations: number,
  canaryCiphertext: string,
  totalShares: number,
  thresholdShares: number,
): Promise<{ valid: true; shares: DmsShare[] } | { valid: false }> {
  return getCall()("resplit", { passphrase, saltBase64, iterations, canaryCiphertext, totalShares, thresholdShares });
}

/**
 * Passphrase Rotation, Emergency Vault half (AGENTS.md §3t amendment,
 * item 1) — verifies `oldPassphrase`, decrypts every `documents` entry
 * with the old key, derives a fresh salt + key from `newPassphrase`,
 * re-encrypts every document, and re-splits the new key — entirely
 * inside the worker. The caller must persist the returned
 * salt/canary/documents/shares atomically (see
 * `rotateVaultPassphrase` in `src/server/dal/dead-mans-switch.ts`).
 */
export function dmsVaultRotate(params: {
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
      shares: DmsShare[];
    }
  | { valid: false }
> {
  return getCall()("rotate", params);
}
