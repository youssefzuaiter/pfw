/**
 * Main-thread handle to `zk-crypto.worker.ts` (AGENTS.md §3x). Every
 * exported function here does nothing but serialize a request, `await`
 * the matching response, and hand back whatever the worker chose to
 * return — payloads only, per this module's name. No function here can
 * return a `CryptoKey`, because the worker never sends one.
 *
 * One worker per browser tab, created lazily on first use and kept alive
 * for the tab's lifetime (matches the previous `useZkVaultStore`-held-key
 * model's "unlock once per session" behavior) — `getWorker()` must only
 * ever be called from inside a browser event handler/effect, never at
 * module top level, since this file is imported by "use client"
 * components that Next also renders once server-side (no `window`,
 * `Worker`, or `self` there); calling any exported function below already
 * guarantees that, so callers don't need to think about it separately.
 */

import { createRpcClient, type RpcCall } from "./worker-rpc";

let worker: Worker | null = null;
let call: RpcCall | null = null;

function getCall(): RpcCall {
  if (!call) {
    worker = new Worker(new URL("./zk-crypto.worker.ts", import.meta.url), { type: "module" });
    call = createRpcClient(worker);
  }
  return call;
}

/** Derives a fresh key from `passphrase`, activates it as this tab's zero-knowledge key, and returns a canary ciphertext to send to `/api/zk/setup`. */
export function zkVaultSetup(passphrase: string, saltBase64: string, iterations: number): Promise<{ canaryCiphertext: string }> {
  return getCall()("setup", { passphrase, saltBase64, iterations });
}

/** Derives a candidate key and verifies it against `canaryCiphertext`; activates it only on success. */
export function zkVaultUnlock(
  passphrase: string,
  saltBase64: string,
  iterations: number,
  canaryCiphertext: string,
): Promise<{ valid: boolean }> {
  return getCall()("unlock", { passphrase, saltBase64, iterations, canaryCiphertext });
}

/** Discards the active key. A subsequent `zkVaultEncrypt`/`zkVaultDecrypt` call will fail until unlocked again. */
export function zkVaultLock(): Promise<{ locked: true }> {
  return getCall()("lock", {});
}

export function zkVaultEncrypt(plaintext: string): Promise<{ ciphertext: string }> {
  return getCall()("encrypt", { plaintext });
}

export function zkVaultDecrypt(ciphertext: string): Promise<{ plaintext: string }> {
  return getCall()("decrypt", { ciphertext });
}
