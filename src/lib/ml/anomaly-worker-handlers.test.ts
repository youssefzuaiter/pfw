import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Mocks `onnxruntime-web` entirely — same reasoning
 * forecaster-worker-handlers.test.ts already documents: no real WASM
 * runtime or model file in a unit test, and the model's own detection
 * QUALITY isn't something a unit test can meaningfully assert on anyway
 * (that's what ml-pipeline/train_autoencoder.py's own validation pass
 * and a real browser walkthrough are for). What IS under test here is
 * the preprocessing pipeline (feature aggregation, normalization) and
 * createAnomalyDetectionHandlers' own orchestration.
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

const WINDOW_END = "2026-09-04";

describe("buildDailyFeatureMatrix", () => {
  it("returns a dense 30x10 matrix of zeros for no transactions", async () => {
    const { buildDailyFeatureMatrix } = await import("./anomaly-worker-handlers");
    const matrix = buildDailyFeatureMatrix([], WINDOW_END);
    expect(matrix).toHaveLength(30);
    for (const day of matrix) {
      expect(day).toHaveLength(10);
      expect(day.every((v) => v === 0)).toBe(true);
    }
  });

  it("buckets a transaction into the correct day and category, including the rent->subscriptions mapping and an unknown slug falling back to other", async () => {
    const { buildDailyFeatureMatrix } = await import("./anomaly-worker-handlers");
    const matrix = buildDailyFeatureMatrix(
      [
        { occurredAtIso: "2026-09-04T10:00:00Z", amountAgorot: 5000, categorySlug: "rent" },
        { occurredAtIso: "2026-09-03T10:00:00Z", amountAgorot: 3000, categorySlug: "groceries" },
        { occurredAtIso: "2026-09-01T10:00:00Z", amountAgorot: 1000, categorySlug: "some-unrecognized-custom-slug" },
      ],
      WINDOW_END,
    );
    // day index 29 = 2026-09-04 (window end); 28 = 2026-09-03; 26 = 2026-09-01
    expect(matrix[29][0]).toBe(5000); // total_spend_agorot
    expect(matrix[29][5]).toBe(5000); // cat_subscriptions_agorot — rent mapped here
    expect(matrix[28][3]).toBe(3000); // cat_groceries_agorot
    expect(matrix[26][9]).toBe(1000); // cat_other_agorot — unknown slug falls back to other
  });

  it("ignores a transaction outside the 30-day window", async () => {
    const { buildDailyFeatureMatrix } = await import("./anomaly-worker-handlers");
    const matrix = buildDailyFeatureMatrix(
      [{ occurredAtIso: "2026-01-01T00:00:00Z", amountAgorot: 999, categorySlug: "groceries" }],
      WINDOW_END,
    );
    expect(matrix.flat().every((v) => v === 0)).toBe(true);
  });

  it("computes max_3h_burst_count correctly: clustered transactions spike it, spread-out ones don't", async () => {
    const { buildDailyFeatureMatrix } = await import("./anomaly-worker-handlers");

    const clustered = buildDailyFeatureMatrix(
      Array.from({ length: 5 }, (_, i) => ({
        occurredAtIso: `2026-09-04T10:${(i * 10).toString().padStart(2, "0")}:00Z`, // 5 txns within 40 minutes
        amountAgorot: 100,
        categorySlug: "shopping",
      })),
      WINDOW_END,
    );
    expect(clustered[29][2]).toBe(5); // all 5 fall within one 3-hour window

    const spread = buildDailyFeatureMatrix(
      Array.from({ length: 5 }, (_, i) => ({
        occurredAtIso: `2026-09-0${1 + i}T10:00:00Z`, // one per day across 5 different days
        amountAgorot: 100,
        categorySlug: "shopping",
      })),
      WINDOW_END,
    );
    expect(spread.every((day) => day[2] <= 1)).toBe(true);
  });

  it("throws RangeError on a malformed windowEndDateKey", async () => {
    const { buildDailyFeatureMatrix } = await import("./anomaly-worker-handlers");
    expect(() => buildDailyFeatureMatrix([], "not-a-date")).toThrow(RangeError);
  });
});

describe("normalizeWindow", () => {
  it("floors a degenerate (all-baseline-zero) feature's std to 1.0, matching train_autoencoder.py's guard", async () => {
    const { normalizeWindow } = await import("./anomaly-worker-handlers");
    const matrix: number[][] = Array.from({ length: 30 }, () => new Array(10).fill(0));
    matrix[29][5] = 9; // log1p(9) = ln(10) — chosen for a clean expected value
    const normalized = normalizeWindow(matrix);
    expect(normalized[29 * 10 + 5]).toBeCloseTo(Math.log(10), 5);
  });

  it("z-scores each feature so the baseline (first 29) days have ~zero mean and ~unit std", async () => {
    const { normalizeWindow } = await import("./anomaly-worker-handlers");
    const matrix: number[][] = Array.from({ length: 30 }, (_, d) => Array.from({ length: 10 }, (_, f) => ((d * 3 + f * 7) % 11) + 1));
    const normalized = normalizeWindow(matrix);
    for (let f = 0; f < 10; f++) {
      const baselineValues: number[] = [];
      for (let d = 0; d < 29; d++) baselineValues.push(normalized[d * 10 + f]);
      const mean = baselineValues.reduce((a, b) => a + b, 0) / baselineValues.length;
      const variance = baselineValues.reduce((a, b) => a + (b - mean) ** 2, 0) / baselineValues.length;
      expect(mean).toBeCloseTo(0, 5);
      expect(Math.sqrt(variance)).toBeCloseTo(1, 5);
    }
  });
});

describe("createAnomalyDetectionHandlers", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates the ONNX session exactly once and feeds it a (1, 30, 10) tensor", async () => {
    runMock.mockImplementation(async (feeds: { input: MockTensor }) => ({ reconstruction: { data: feeds.input.data } }));
    const { createAnomalyDetectionHandlers } = await import("./anomaly-worker-handlers");
    const handlers = createAnomalyDetectionHandlers();

    await handlers.checkAnomaly({ transactions: [], windowEndDateKey: WINDOW_END });

    expect(createSessionMock).toHaveBeenCalledTimes(1);
    const dims = (runMock.mock.calls[0][0] as { input: MockTensor }).input.dims;
    expect(dims).toEqual([1, 30, 10]);
  });

  it("classifies NORMAL with zero signal when reconstruction exactly matches the normalized input", async () => {
    runMock.mockImplementation(async (feeds: { input: MockTensor }) => ({ reconstruction: { data: feeds.input.data } }));
    const { createAnomalyDetectionHandlers } = await import("./anomaly-worker-handlers");
    const handlers = createAnomalyDetectionHandlers();

    const result = await handlers.checkAnomaly({ transactions: [], windowEndDateKey: WINDOW_END });

    expect(result.tier).toBe("NORMAL");
    expect(result.signal).toBe(0);
  });

  it("classifies HIGH when the model badly mis-reconstructs the last day, and identifies the top contributing feature/category", async () => {
    runMock.mockImplementation(async (feeds: { input: MockTensor }) => {
      const reconstruction = new Float32Array(feeds.input.data);
      reconstruction[29 * 10 + 5] += 100; // huge error specifically on cat_subscriptions_agorot, last day
      return { reconstruction: { data: reconstruction } };
    });
    const { createAnomalyDetectionHandlers } = await import("./anomaly-worker-handlers");
    const handlers = createAnomalyDetectionHandlers();

    const result = await handlers.checkAnomaly({ transactions: [], windowEndDateKey: WINDOW_END });

    expect(result.tier).toBe("HIGH");
    expect(result.topFeature).toBe("cat_subscriptions_agorot");
    expect(result.topCategory).toBe("subscriptions");
  });

  it("configures the exact self-hosted asyncify WASM asset paths already vendored under public/onnx-runtime/", async () => {
    runMock.mockImplementation(async (feeds: { input: MockTensor }) => ({ reconstruction: { data: feeds.input.data } }));
    const ort = await import("onnxruntime-web");
    const { createAnomalyDetectionHandlers } = await import("./anomaly-worker-handlers");
    const handlers = createAnomalyDetectionHandlers();

    await handlers.checkAnomaly({ transactions: [], windowEndDateKey: WINDOW_END });

    expect(ort.env.wasm.wasmPaths).toEqual({
      wasm: "/onnx-runtime/ort-wasm-simd-threaded.asyncify.wasm",
      mjs: "/onnx-runtime/ort-wasm-simd-threaded.asyncify.mjs",
    });
    expect(ort.env.wasm.numThreads).toBe(1);
  });
});
