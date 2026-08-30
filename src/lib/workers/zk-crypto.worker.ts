/**
 * Dedicated Web Worker hosting `src/lib/zk-crypto.ts`'s key derivation and
 * AES-GCM operations (AGENTS.md §3m, §3x).
 *
 * Before this file existed, the derived `CryptoKey` lived in
 * `useZkVaultStore` — ordinary main-thread JS state, in the same heap and
 * realm as every third-party script and every future bug this app will
 * ever ship. A Worker is a genuinely separate V8 isolate with its own
 * heap: `createZkCryptoHandlers`'s `activeKey` closure is not reachable
 * from main-thread code, not even via a debugger attached to the page —
 * only `postMessage` crosses the boundary, and the only things this
 * worker ever posts back are ciphertext, plaintext, and booleans, never
 * the key itself. That is the actual security property this file buys —
 * `useZkVaultStore` holding the raw `CryptoKey` was already safe against
 * a passive network observer (nothing left the browser) but not against
 * an XSS payload running arbitrary JS in the same realm; this closes that
 * gap specifically.
 *
 * Kept as one persistent worker per browser tab (constructed lazily by
 * `zk-vault-worker-client.ts`), not spawned fresh per operation — PBKDF2
 * at 600,000 iterations is deliberately expensive (that's the whole
 * point, per OWASP's guidance cited in zk-crypto.ts), and re-paying it on
 * every encrypt/decrypt call would defeat "unlock once per session."
 *
 * Deliberately just this one line beyond its imports — the actual
 * request handlers live in zk-crypto-worker-handlers.ts precisely so
 * they're importable and testable without a real Worker global (which
 * this project's test environments don't provide); this file's only job
 * is wiring that factory's output to the real message channel, which is
 * exactly the one line here that can't be exercised outside an actual
 * Worker and so isn't unit-tested directly.
 */

import { createZkCryptoHandlers } from "./zk-crypto-worker-handlers";
import { serveRpc } from "./worker-rpc";

serveRpc(createZkCryptoHandlers());
