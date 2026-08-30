/**
 * Dedicated Web Worker hosting `src/lib/dead-mans-switch-crypto.ts`'s key
 * derivation/AES-GCM operations AND `src/lib/shamir-secret-sharing.ts`'s
 * splitting (AGENTS.md §3t, §3x) — both live in the same worker, not two
 * separate ones, because splitting only ever needs to happen against the
 * raw key bytes this worker derives, and the whole point of moving either
 * of them off the main thread is that those raw bytes never need to exist
 * anywhere else. See `zk-crypto.worker.ts`'s doc comment for why a Worker
 * (a separate V8 isolate/heap) is the actual isolation boundary this
 * buys, not merely "fewer lines on the main thread."
 *
 * `setup()` (in `dead-mans-switch-crypto-worker-handlers.ts`) is the one
 * place the raw 32-byte master key (`deriveVaultKeyBytes`'s return value)
 * exists at all: derived, used to import the AES key and split into
 * shares, explicitly zeroed (`rawKey.fill(0)`) the moment both are done,
 * and never returned to the caller. What DOES cross back out to the main
 * thread — the per-beneficiary encoded share strings — is exactly the
 * data this feature's whole distribution flow requires showing the user
 * (AGENTS.md §3t: each share is meaningless alone, only threshold-many
 * together reconstruct the key), not the master key itself.
 *
 * Deliberately just this one line beyond its imports — see
 * `zk-crypto.worker.ts`'s matching comment for why the actual handlers
 * live in a separate, side-effect-free, directly-testable module.
 */

import { createDmsCryptoHandlers } from "./dead-mans-switch-crypto-worker-handlers";
import { serveRpc } from "./worker-rpc";

serveRpc(createDmsCryptoHandlers());
