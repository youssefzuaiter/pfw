/**
 * The actual ONNX Runtime Web inference logic
 * `src/workers/forecaster.worker.ts` serves (AGENTS.md §3dd) — split into
 * its own module with no top-level `self`/`postMessage` reference, same
 * reasoning `local-embedder-worker-handlers.ts`/`zk-crypto-worker-handlers.ts`
 * already establish (§3u/§3x): importable and directly testable without a
 * real Worker global, which neither this project's "unit" (Node) nor
 * "component" (jsdom) vitest environment provides.
 *
 * Loads `scripts/train-forecaster.py`'s exported single-step LSTM cell
 * (public/models/cashflow-forecaster.onnx — see that script's module
 * docstring for the full architecture rationale) and drives it two ways
 * from ONE small graph:
 *   1. Warmup — teacher-forced over the caller's REAL daily history,
 *      batch=1, building a hidden state that reflects this specific
 *      user's actual recent cash-flow pattern. The model's own
 *      predictions are discarded here; only the state update matters.
 *   2. Rollout — autoregressive for 30 days, batched across `numPaths`
 *      independent Monte Carlo paths in ONE `session.run()` call per
 *      day (not one call per path per day) — each path samples its own
 *      next delta from the model's predicted N(mean, exp(logVar)) via
 *      `sampleNormal` (reused from src/lib/monte-carlo.ts, not a second
 *      hand-rolled Box-Muller) and feeds that sample back in as the next
 *      step's input. Per-day p5/p50/p95 are the empirical percentiles of
 *      the resulting balance across all paths at that day — the same
 *      "many stochastic paths, then take percentiles" approach
 *      src/lib/monte-carlo.ts already uses, not a closed-form propagation
 *      of 30 days of compounding Gaussians.
 */

import * as ort from "onnxruntime-web";
import { sampleNormal } from "../lib/monte-carlo";

const MODEL_URL = "/models/cashflow-forecaster.onnx";
const INPUT_SIZE = 3; // [prevDeltaNormalized, sin(dow), cos(dow)] — must match train-forecaster.py's INPUT_SIZE
const HIDDEN_SIZE = 32; // must match train-forecaster.py's HIDDEN_SIZE
const ROLLOUT_DAYS = 30;
const DEFAULT_NUM_PATHS = 200;
const MIN_NUM_PATHS = 10;
const MAX_NUM_PATHS = 2000;

export type ForecastRequest = {
  /** Today's actual liquid balance — every sampled path starts from this same real number. */
  startingBalanceAgorot: number;
  /** Oldest-first, dense (zero-filled) daily net cash flow in agorot — `dates[i]` is `dailyHistoryAgorot[i]`'s calendar date. */
  dailyHistoryAgorot: number[];
  /** ISO `YYYY-MM-DD`, same length/order as dailyHistoryAgorot. */
  dates: string[];
  /** Monte Carlo path count for the rollout — clamped to a sane range regardless of what's requested (a same-origin sanity guard, not a real trust boundary; this call only ever originates from this app's own main-thread client). */
  numPaths?: number;
};

export type ForecastDayResult = {
  dayIndex: number; // 1..30
  date: string;
  meanAgorot: number;
  p5Agorot: number;
  p50Agorot: number;
  p95Agorot: number;
};

export type ForecastResponse = { days: ForecastDayResult[] };

export type ForecasterHandlers = { forecast(request: ForecastRequest): Promise<ForecastResponse> };

function dayOfWeekFeatures(dateKey: string): [sin: number, cos: number] {
  const dow = new Date(`${dateKey}T00:00:00Z`).getUTCDay(); // 0=Sunday..6=Saturday
  const angle = (2 * Math.PI * dow) / 7;
  return [Math.sin(angle), Math.cos(angle)];
}

function addDaysIso(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Population std dev — matches train-forecaster.py's numpy `.std()` default (ddof=0), so the Worker's normalization convention is identical to what the model was trained under. */
function stdDev(values: readonly number[], meanValue: number): number {
  const variance = values.reduce((sum, v) => sum + (v - meanValue) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function percentile(sortedAscending: readonly number[], p: number): number {
  const index = Math.min(sortedAscending.length - 1, Math.max(0, Math.floor(p * sortedAscending.length)));
  return sortedAscending[index];
}

// `ort.Tensor#data` types as Float32Array<ArrayBufferLike> (its backing
// buffer isn't guaranteed to be a plain ArrayBuffer specifically), which
// TypeScript's typed-array generics (5.7+) treat as distinct from the
// Float32Array<ArrayBuffer> that `new Float32Array(n)` infers — this
// local alias is used everywhere a value might have come FROM a tensor,
// so the two never need reconciling via a cast.
type F32 = Float32Array<ArrayBufferLike>;

type CellStepResult = { mean: F32; logVar: F32; h: F32; c: F32 };

async function runCellStep(
  session: ort.InferenceSession,
  input: F32,
  h: F32,
  c: F32,
  batch: number,
): Promise<CellStepResult> {
  const feeds = {
    input: new ort.Tensor("float32", input, [batch, INPUT_SIZE]),
    h_in: new ort.Tensor("float32", h, [batch, HIDDEN_SIZE]),
    c_in: new ort.Tensor("float32", c, [batch, HIDDEN_SIZE]),
  };
  const results = await session.run(feeds);
  return {
    mean: results.mean.data as F32,
    logVar: results.log_var.data as F32,
    h: results.h_out.data as F32,
    c: results.c_out.data as F32,
  };
}

/**
 * One fresh pipeline-cache closure per call, mirroring
 * `createLocalEmbedderHandlers`'s shape (§3u) — in production,
 * `forecaster.worker.ts` calls this exactly once per Worker instance,
 * and that instance is terminated by the main thread the moment its one
 * `forecast` call resolves (`forecaster-client.ts`) rather than kept
 * warm — this feature computes once per dashboard load, not repeatedly
 * like inline recategorization, so there's no "stay warm for the next
 * call" case worth optimizing for here.
 */
export function createForecasterHandlers(options: { randomFn?: () => number } = {}): ForecasterHandlers {
  const randomFn = options.randomFn ?? Math.random;
  let sessionPromise: Promise<ort.InferenceSession> | null = null;

  function getSession(): Promise<ort.InferenceSession> {
    if (!sessionPromise) {
      sessionPromise = (async () => {
        // Same self-hosted WASM runtime local-embedder-worker-handlers.ts
        // already uses (§3u) — the EXACT .asyncify filenames, not left to
        // onnxruntime-web's own default variant selection (its own type
        // declarations say the default is the PLAIN, non-asyncify
        // filename unless WebGPU/WebNN is requested); this app
        // self-hosts only the asyncify pair under public/onnx-runtime/
        // (§3u: "only one WASM core variant is shipped, on purpose"), so
        // leaving this unset would 404 against a file that was never
        // vendored.
        ort.env.wasm.wasmPaths = {
          wasm: "/onnx-runtime/ort-wasm-simd-threaded.asyncify.wasm",
          mjs: "/onnx-runtime/ort-wasm-simd-threaded.asyncify.mjs",
        };
        ort.env.wasm.numThreads = 1;
        return ort.InferenceSession.create(MODEL_URL, { executionProviders: ["wasm"] });
      })();
    }
    return sessionPromise;
  }

  return {
    async forecast(request) {
      const { startingBalanceAgorot, dailyHistoryAgorot, dates } = request;
      if (dailyHistoryAgorot.length === 0 || dailyHistoryAgorot.length !== dates.length) {
        throw new RangeError("dailyHistoryAgorot and dates must be the same non-zero length");
      }
      const numPaths = Math.min(MAX_NUM_PATHS, Math.max(MIN_NUM_PATHS, Math.round(request.numPaths ?? DEFAULT_NUM_PATHS)));

      const session = await getSession();

      const historyMean = mean(dailyHistoryAgorot);
      // A near-zero (or exactly zero) std — an account with flat/no
      // history — falls back to 1 rather than dividing by ~0, the same
      // guard train-forecaster.py's synthetic-data normalization uses
      // for the same reason.
      const historyStd = stdDev(dailyHistoryAgorot, historyMean) || 1;

      // --- Warmup: teacher-forced over REAL history, batch=1 ---
      let h: F32 = new Float32Array(HIDDEN_SIZE);
      let c: F32 = new Float32Array(HIDDEN_SIZE);
      let prevNormalized = 0;
      for (let i = 0; i < dailyHistoryAgorot.length; i++) {
        const [dowSin, dowCos] = dayOfWeekFeatures(dates[i]);
        const step = await runCellStep(session, new Float32Array([prevNormalized, dowSin, dowCos]), h, c, 1);
        h = step.h;
        c = step.c;
        prevNormalized = (dailyHistoryAgorot[i] - historyMean) / historyStd;
      }

      // --- Rollout: autoregressive, batched across numPaths ---
      let hBatch: F32 = new Float32Array(numPaths * HIDDEN_SIZE);
      let cBatch: F32 = new Float32Array(numPaths * HIDDEN_SIZE);
      for (let p = 0; p < numPaths; p++) {
        hBatch.set(h, p * HIDDEN_SIZE);
        cBatch.set(c, p * HIDDEN_SIZE);
      }
      const prevNormalizedBatch = new Float32Array(numPaths).fill(prevNormalized);
      const runningBalances = new Float64Array(numPaths).fill(startingBalanceAgorot);

      const lastHistoryDate = dates[dates.length - 1];
      const days: ForecastDayResult[] = [];

      for (let day = 1; day <= ROLLOUT_DAYS; day++) {
        const futureDate = addDaysIso(lastHistoryDate, day);
        const [dowSin, dowCos] = dayOfWeekFeatures(futureDate);

        const input = new Float32Array(numPaths * INPUT_SIZE);
        for (let p = 0; p < numPaths; p++) {
          input[p * INPUT_SIZE] = prevNormalizedBatch[p];
          input[p * INPUT_SIZE + 1] = dowSin;
          input[p * INPUT_SIZE + 2] = dowCos;
        }

        const step = await runCellStep(session, input, hBatch, cBatch, numPaths);
        hBatch = step.h;
        cBatch = step.c;

        const dayBalances = new Array<number>(numPaths);
        for (let p = 0; p < numPaths; p++) {
          const predictedMean = step.mean[p];
          const predictedStd = Math.exp(step.logVar[p] / 2);
          const sampledNormalized = sampleNormal(predictedMean, predictedStd, randomFn);
          prevNormalizedBatch[p] = sampledNormalized;

          const sampledDeltaAgorot = sampledNormalized * historyStd + historyMean;
          runningBalances[p] += sampledDeltaAgorot;
          dayBalances[p] = runningBalances[p];
        }

        const sorted = [...dayBalances].sort((a, b) => a - b);
        days.push({
          dayIndex: day,
          date: futureDate,
          meanAgorot: Math.round(mean(dayBalances)),
          p5Agorot: Math.round(percentile(sorted, 0.05)),
          p50Agorot: Math.round(percentile(sorted, 0.5)),
          p95Agorot: Math.round(percentile(sorted, 0.95)),
        });
      }

      return { days };
    },
  };
}
