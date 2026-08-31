/**
 * Dedicated Web Worker hosting the cash-flow forecaster's ONNX Runtime
 * Web inference (AGENTS.md §3dd). Deliberately just this one line beyond
 * its imports — see `local-embedder.worker.ts`'s matching comment (§3u)
 * for why the actual logic lives in a separate, side-effect-free,
 * directly-testable module.
 */

import { createForecasterHandlers } from "./forecaster-worker-handlers";
import { serveRpc } from "../lib/workers/worker-rpc";

serveRpc(createForecasterHandlers());
