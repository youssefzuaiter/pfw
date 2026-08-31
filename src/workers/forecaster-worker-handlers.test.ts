import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Mocks `onnxruntime-web` entirely — same reasoning
 * local-embedder.test.ts already documents for mocking
 * `@huggingface/transformers`: no real WASM runtime or model file in a
 * unit test, and the model's own forecasting QUALITY isn't something a
 * unit test can meaningfully assert on anyway (that's what
 * scripts/train-forecaster.py's own verify_onnx() step and a real
 * browser walkthrough are for). What IS under test here is
 * createForecasterHandlers' own orchestration: warmup/rollout call
 * counts and shapes, percentile computation, input validation, and the
 * exact self-hosted WASM asset paths.
 */
const runMock = vi.fn();
const createSessionMock = vi.fn(async () => ({ run: runMock }));

class MockTensor {
  type: string;
  data: Float32Array;
  dims: number[];
  constructor(type: string, data: Float32Array, dims: number[]) {
    this.type = type;
    this.data = data;
    this.dims = dims;
  }
}

vi.mock("onnxruntime-web", () => ({
  Tensor: MockTensor,
  InferenceSession: { create: () => createSessionMock() },
  env: { wasm: {} },
}));

const HIDDEN_SIZE = 32;

/** A `randomFn` sequence that makes src/lib/monte-carlo.ts's Box-Muller `sampleNormal` return EXACTLY `mean` every call — u1=0.5 (any non-zero value), u2=0.25 (cos(2π·0.25) = cos(π/2) = 0), so `mean + stdDev * 0 = mean`. Makes every sampled path's trajectory exactly predictable instead of merely bounded, so tests can assert on precise numbers. */
function makeExactMeanRandom(): () => number {
  let toggle = true;
  return () => {
    toggle = !toggle;
    return toggle ? 0.25 : 0.5;
  };
}

/** mean is a function of the (0-based) row/path index within the batch — the mock reads it straight off the fed-in `input` tensor's batch size, so a warmup call (batch=1) and a rollout call (batch=numPaths) both work without special-casing. logVar is always 0 (std = 1) unless overridden. */
function configureMockRun(meanForPath: (pathIndex: number) => number, logVar = 0) {
  runMock.mockImplementation(async (feeds: { input: MockTensor }) => {
    const batch = feeds.input.dims[0];
    const meanData = new Float32Array(batch);
    const logVarData = new Float32Array(batch);
    for (let p = 0; p < batch; p++) {
      meanData[p] = meanForPath(p);
      logVarData[p] = logVar;
    }
    return {
      mean: { data: meanData },
      log_var: { data: logVarData },
      h_out: { data: new Float32Array(batch * HIDDEN_SIZE) },
      c_out: { data: new Float32Array(batch * HIDDEN_SIZE) },
    };
  });
}

const HISTORY_DATES = Array.from({ length: 90 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 0, 1));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
});
const HISTORY_DELTAS = Array.from({ length: 90 }, () => 0);

describe("createForecasterHandlers", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("produces exactly 30 days of results, numbered 1..30 with correctly incrementing calendar dates", async () => {
    configureMockRun(() => 0);
    const { createForecasterHandlers } = await import("./forecaster-worker-handlers");
    const handlers = createForecasterHandlers({ randomFn: makeExactMeanRandom() });

    const response = await handlers.forecast({
      startingBalanceAgorot: 100_000,
      dailyHistoryAgorot: HISTORY_DELTAS,
      dates: HISTORY_DATES,
    });

    expect(response.days).toHaveLength(30);
    expect(response.days.map((d) => d.dayIndex)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(response.days[0].date).toBe("2026-04-01"); // day after the last history date (2026-03-31)
    expect(response.days[29].date).toBe("2026-04-30");
  });

  it("runs one warmup call per history day (batch=1) plus one rollout call per rollout day (batch=numPaths)", async () => {
    configureMockRun(() => 0);
    const { createForecasterHandlers } = await import("./forecaster-worker-handlers");
    const handlers = createForecasterHandlers({ randomFn: makeExactMeanRandom() });

    await handlers.forecast({
      startingBalanceAgorot: 0,
      dailyHistoryAgorot: HISTORY_DELTAS,
      dates: HISTORY_DATES,
      numPaths: 50,
    });

    expect(runMock).toHaveBeenCalledTimes(HISTORY_DATES.length + 30);
    const warmupCallDims = (runMock.mock.calls[0][0] as { input: MockTensor }).input.dims;
    expect(warmupCallDims).toEqual([1, 3]);
    const rolloutCallDims = (runMock.mock.calls[HISTORY_DATES.length][0] as { input: MockTensor }).input.dims;
    expect(rolloutCallDims).toEqual([50, 3]);
  });

  it("creates the ONNX session exactly once, reused for both warmup and every rollout step", async () => {
    configureMockRun(() => 0);
    const { createForecasterHandlers } = await import("./forecaster-worker-handlers");
    const handlers = createForecasterHandlers({ randomFn: makeExactMeanRandom() });

    await handlers.forecast({ startingBalanceAgorot: 0, dailyHistoryAgorot: HISTORY_DELTAS, dates: HISTORY_DATES });

    expect(createSessionMock).toHaveBeenCalledTimes(1);
  });

  it("configures the exact self-hosted asyncify WASM asset paths already vendored under public/onnx-runtime/", async () => {
    configureMockRun(() => 0);
    const ort = await import("onnxruntime-web");
    const { createForecasterHandlers } = await import("./forecaster-worker-handlers");
    const handlers = createForecasterHandlers({ randomFn: makeExactMeanRandom() });

    await handlers.forecast({ startingBalanceAgorot: 0, dailyHistoryAgorot: HISTORY_DELTAS, dates: HISTORY_DATES });

    expect(ort.env.wasm.wasmPaths).toEqual({
      wasm: "/onnx-runtime/ort-wasm-simd-threaded.asyncify.wasm",
      mjs: "/onnx-runtime/ort-wasm-simd-threaded.asyncify.mjs",
    });
    expect(ort.env.wasm.numThreads).toBe(1);
  });

  it("with a zero-mean, zero-history model, the projected balance stays exactly at the starting balance every day", async () => {
    configureMockRun(() => 0);
    const { createForecasterHandlers } = await import("./forecaster-worker-handlers");
    const handlers = createForecasterHandlers({ randomFn: makeExactMeanRandom() });

    const response = await handlers.forecast({
      startingBalanceAgorot: 500_000,
      dailyHistoryAgorot: HISTORY_DELTAS,
      dates: HISTORY_DATES,
    });

    for (const day of response.days) {
      expect(day.meanAgorot).toBe(500_000);
      expect(day.p5Agorot).toBe(500_000);
      expect(day.p50Agorot).toBe(500_000);
      expect(day.p95Agorot).toBe(500_000);
    }
  });

  it("percentiles reflect real cross-path spread when the model predicts different means per path", async () => {
    const numPaths = 100;
    // Path p predicts a mean of (p - 50) — a uniform spread from -50 to +49.
    // With HISTORY_DELTAS all zero, historyStd falls back to 1 (the
    // divide-by-~0 guard), so this mean IS the de-normalized agorot
    // delta directly (mean * 1 + 0 = mean).
    configureMockRun((p) => p - 50);
    const { createForecasterHandlers } = await import("./forecaster-worker-handlers");
    const handlers = createForecasterHandlers({ randomFn: makeExactMeanRandom() });

    const response = await handlers.forecast({
      startingBalanceAgorot: 0,
      dailyHistoryAgorot: HISTORY_DELTAS,
      dates: HISTORY_DATES,
      numPaths,
    });

    const day1 = response.days[0];
    // Sorted balances after day 1 are exactly -50..49 (100 values).
    // p5 index = floor(0.05*100) = 5 -> value -45; p50 index = 50 -> value 0;
    // p95 index = floor(0.95*100) = 95 -> value 45.
    expect(day1.p5Agorot).toBe(-45);
    expect(day1.p50Agorot).toBe(0);
    expect(day1.p95Agorot).toBe(45);
    expect(day1.meanAgorot).toBe(-0); // mean of -50..49 is -0.5, rounds to -0 in JS — a real, if cosmetic, edge case worth pinning
  });

  it("rejects mismatched dailyHistoryAgorot/dates lengths without ever calling the session", async () => {
    configureMockRun(() => 0);
    const { createForecasterHandlers } = await import("./forecaster-worker-handlers");
    const handlers = createForecasterHandlers({ randomFn: makeExactMeanRandom() });

    await expect(
      handlers.forecast({ startingBalanceAgorot: 0, dailyHistoryAgorot: [1, 2, 3], dates: ["2026-01-01"] }),
    ).rejects.toThrow(RangeError);
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it("rejects an empty history", async () => {
    configureMockRun(() => 0);
    const { createForecasterHandlers } = await import("./forecaster-worker-handlers");
    const handlers = createForecasterHandlers({ randomFn: makeExactMeanRandom() });

    await expect(handlers.forecast({ startingBalanceAgorot: 0, dailyHistoryAgorot: [], dates: [] })).rejects.toThrow(
      RangeError,
    );
  });

  it("clamps an absurdly large numPaths to the sane maximum rather than batching millions of paths", async () => {
    configureMockRun(() => 0);
    const { createForecasterHandlers } = await import("./forecaster-worker-handlers");
    const handlers = createForecasterHandlers({ randomFn: makeExactMeanRandom() });

    await handlers.forecast({
      startingBalanceAgorot: 0,
      dailyHistoryAgorot: HISTORY_DELTAS,
      dates: HISTORY_DATES,
      numPaths: 1_000_000,
    });

    const rolloutDims = (runMock.mock.calls[HISTORY_DATES.length][0] as { input: MockTensor }).input.dims;
    expect(rolloutDims[0]).toBe(2000); // MAX_NUM_PATHS
  });

  it("clamps a too-small numPaths up to the sane minimum", async () => {
    configureMockRun(() => 0);
    const { createForecasterHandlers } = await import("./forecaster-worker-handlers");
    const handlers = createForecasterHandlers({ randomFn: makeExactMeanRandom() });

    await handlers.forecast({
      startingBalanceAgorot: 0,
      dailyHistoryAgorot: HISTORY_DELTAS,
      dates: HISTORY_DATES,
      numPaths: 1,
    });

    const rolloutDims = (runMock.mock.calls[HISTORY_DATES.length][0] as { input: MockTensor }).input.dims;
    expect(rolloutDims[0]).toBe(10); // MIN_NUM_PATHS
  });
});
