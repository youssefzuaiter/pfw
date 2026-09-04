/**
 * Dedicated Web Worker hosting the spending-anomaly detector's ONNX
 * Runtime Web inference (AGENTS.md, "Behavioral Spending Anomaly
 * Detection"). Deliberately just this one line beyond its imports — see
 * `forecaster.worker.ts`'s matching comment for why the actual logic
 * lives in a separate, side-effect-free, directly-testable module.
 */

import { createAnomalyDetectionHandlers } from "./anomaly-worker-handlers";
import { serveRpc } from "../workers/worker-rpc";

serveRpc(createAnomalyDetectionHandlers());
