/**
 * Dedicated Web Worker hosting Transformers.js's feature-extraction
 * pipeline (AGENTS.md §3u, §3y).
 *
 * Before this file existed, the WASM runtime and the loaded ~90MB model
 * lived in a module-level cache on the MAIN thread (`local-embedder.ts`'s
 * old `pipelinePromise`) — once instantiated, that memory was pinned for
 * the rest of the page's lifetime; nothing short of a full page reload
 * could ever release it back to the browser. Running it inside a Worker
 * instead means `local-embedder.ts`'s `terminateEmbedderWorker()` can
 * actually reclaim that memory on demand — terminating a Worker tears
 * down its entire realm, WASM linear memory included, which is not
 * something achievable from the main thread by any amount of clearing a
 * cached reference. See that function's own doc comment for when this
 * app actually calls it.
 *
 * Deliberately just this one line beyond its imports — see
 * `zk-crypto.worker.ts`'s matching comment (§3x) for why the actual
 * logic lives in a separate, side-effect-free, directly-testable module.
 */

import { createLocalEmbedderHandlers } from "./local-embedder-worker-handlers";
import { serveRpc } from "../workers/worker-rpc";

serveRpc(createLocalEmbedderHandlers());
