"use client";

import { createRpcClient } from "../workers/worker-rpc";
import type { AnomalyCheckRequest, AnomalyCheckResponse } from "./anomaly-worker-handlers";

/**
 * Main-thread entry point for the spending-anomaly detector (AGENTS.md,
 * "Behavioral Spending Anomaly Detection"). No financial data ever
 * leaves the device to compute this — the transaction history is
 * aggregated, normalized, and run through the ONNX model entirely inside
 * the Worker, same property this app's other client-side models already
 * hold (§3u, §3dd, §3aa).
 *
 * One-shot lifecycle, mirroring `forecaster-client.ts`'s `runForecast`
 * rather than `local-embedder.ts`'s "stay warm" pattern: this runs once
 * per dashboard load, so instantiate → run the one `checkAnomaly` call →
 * terminate, every time, is the simplest correct shape — no persistent
 * module-level Worker reference to leak if the caller unmounts
 * mid-flight. The `finally` block terminates on the error path too.
 */
export async function runAnomalyCheck(request: AnomalyCheckRequest): Promise<AnomalyCheckResponse> {
  const worker = new Worker(new URL("./anomaly-worker.ts", import.meta.url), { type: "module" });
  try {
    const call = createRpcClient(worker);
    return await call<AnomalyCheckResponse>("checkAnomaly", request);
  } finally {
    worker.terminate();
  }
}
