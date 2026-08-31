"use client";

import { createRpcClient } from "../lib/workers/worker-rpc";
import type { ForecastRequest, ForecastResponse } from "./forecaster-worker-handlers";

/**
 * Main-thread entry point for the cash-flow forecaster (AGENTS.md §3dd).
 * Unlike `local-embedder.ts`'s "construct lazily, keep warm, terminate
 * explicitly on demand" lifecycle (right for a Worker that serves many
 * interactive calls over a session), this one is a genuine one-shot:
 * `RunwayForecastChart` calls this once per dashboard load, so the
 * simplest correct lifecycle is instantiate → run the one RPC call →
 * terminate, every time, with no persistent module-level Worker
 * reference to leak if the component unmounts mid-flight. The `finally`
 * block terminates the Worker on the error path too, not just the
 * success path — a thrown/rejected inference call must never leave the
 * Worker's WASM linear memory pinned for the rest of the tab's life.
 */
export async function runForecast(request: ForecastRequest): Promise<ForecastResponse> {
  const worker = new Worker(new URL("./forecaster.worker.ts", import.meta.url), { type: "module" });
  try {
    const call = createRpcClient(worker);
    return await call<ForecastResponse>("forecast", request);
  } finally {
    worker.terminate();
  }
}
