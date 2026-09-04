/**
 * The actual ONNX Runtime Web inference logic `anomaly-worker.ts` serves
 * (AGENTS.md, "Behavioral Spending Anomaly Detection") — split into its
 * own module with no top-level `self`/`postMessage` reference, same
 * reasoning `forecaster-worker-handlers.ts`/`local-embedder-worker-handlers.ts`
 * already establish: importable and directly testable without a real
 * Worker global, which neither this project's "unit" (Node) nor
 * "component" (jsdom) vitest environment provides.
 *
 * Loads `ml-pipeline/train_autoencoder.py`'s exported LSTM autoencoder
 * (public/models/spending_anomaly.onnx — see that script's module
 * docstring for the full architecture/normalization/threshold rationale)
 * and reproduces its exact preprocessing pipeline in TypeScript:
 *
 *   1. Aggregate the caller's raw transactions into a dense 30-day x
 *      10-feature matrix (buildDailyFeatureMatrix) — total spend,
 *      transaction count, a 3-hour burst-count velocity signal, and 7
 *      category-bucket totals, matching ml-pipeline/synthesize_ledger.py's
 *      exact feature order.
 *   2. log1p every value, then z-score using ONLY the leading 29 days as
 *      the "known normal" baseline (normalizeWindow) — the trailing 1
 *      day (RECENT_EVAL_DAYS) is what's being evaluated, never folded
 *      into the statistic that judges it. See
 *      train_autoencoder.py's normalize_windows() docstring for why
 *      log1p isn't optional and why the baseline/recent split exists at
 *      all — both are fixes for real bugs found while training this
 *      model, not stylistic choices.
 *   3. Run the normalized tensor through the ONNX model, compute squared
 *      reconstruction error on just the final day (mean over the feature
 *      dimension), and classify it against the model's own bootstrap-CI
 *      thresholds (HIGH / MARGINAL / NORMAL).
 *
 * All constants below (WINDOW_DAYS, NUM_FEATURES, BASELINE_DAYS,
 * RECENT_EVAL_DAYS, the thresholds) are copied from the trained model's
 * public/models/spending_anomaly.meta.json — same "hardcode with a
 * must-match comment" precedent forecaster-worker-handlers.ts already
 * uses for train-forecaster.py's constants, not a runtime fetch of a
 * second file alongside the .onnx binary.
 */

import * as ort from "onnxruntime-web";

const MODEL_URL = "/models/spending_anomaly.onnx";

const WINDOW_DAYS = 30; // must match ml-pipeline/synthesize_ledger.py's WINDOW_DAYS
const BASELINE_DAYS = 29; // must match ml-pipeline/train_autoencoder.py's BASELINE_DAYS
const RECENT_EVAL_DAYS = 1; // must match ml-pipeline/train_autoencoder.py's RECENT_EVAL_DAYS
const BURST_WINDOW_MINUTES = 3 * 60; // must match ml-pipeline/synthesize_ledger.py's BURST_WINDOW_MINUTES
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Copied from public/models/spending_anomaly.meta.json's "thresholds" —
// regenerate these (and the constants above) if the model is ever
// retrained with different hyperparameters or a new bootstrap run.
const THETA_LO = 1.0396369874477387;
const THETA_HI = 1.2275562047958375;

const CATEGORIES = ["groceries", "dining", "subscriptions", "shopping", "transport", "entertainment", "other"] as const;
type CategoryBucket = (typeof CATEGORIES)[number];

const FEATURE_NAMES = [
  "total_spend_agorot",
  "transaction_count",
  "max_3h_burst_count",
  ...CATEGORIES.map((c) => `cat_${c}_agorot`),
] as const;
const NUM_FEATURES = FEATURE_NAMES.length;

/**
 * This app's real `Category.slug` values (prisma/seed/israeli-data.ts)
 * don't line up one-to-one with the 7 synthetic buckets the model was
 * trained on — this table is the mapping. `rent` deliberately maps to
 * `subscriptions`, not `other`: both are a fixed-price RECURRING charge,
 * which is exactly the pattern the model was trained to catch a price
 * hike on (see synthesize_ledger.py's `subscription_creep` injection) —
 * a rent increase is behaviorally the same event as a subscription price
 * hike, just a bigger number, and per-window normalization (this
 * module's normalizeWindow) already handles arbitrary absolute scale.
 * Anything not listed here (including a user's own custom category)
 * falls back to "other" rather than throwing — a real user's category
 * list is not a closed set this module can enumerate in advance.
 */
const CATEGORY_SLUG_TO_BUCKET: Record<string, CategoryBucket> = {
  groceries: "groceries",
  dining: "dining",
  transport: "transport",
  entertainment: "entertainment",
  shopping: "shopping",
  rent: "subscriptions",
  utilities: "other",
  health: "other",
  uncategorized: "other",
};

function bucketForCategorySlug(slug: string): CategoryBucket {
  return CATEGORY_SLUG_TO_BUCKET[slug] ?? "other";
}

export type RawSpendingTransaction = {
  /** Full ISO 8601 timestamp (date + time) — the time-of-day component feeds the burst/velocity feature. */
  occurredAtIso: string;
  /** Positive magnitude of an EXPENSE, in agorot — the caller filters out income before this module ever sees a row. */
  amountAgorot: number;
  categorySlug: string;
};

export type AnomalyCheckRequest = {
  transactions: RawSpendingTransaction[];
  /** ISO `YYYY-MM-DD` — the last (most recent) day of the 30-day window being evaluated, i.e. "today" from the caller's perspective. */
  windowEndDateKey: string;
};

export type AnomalyTier = "HIGH" | "MARGINAL" | "NORMAL";

export type AnomalyCheckResponse = {
  tier: AnomalyTier;
  /** The raw reconstruction-error signal that tier was computed from — exposed for debugging/logging, not meant to be shown to a user directly. */
  signal: number;
  thresholds: { thetaLo: number; thetaHi: number };
  /** Which of the 10 features had the largest reconstruction error on the evaluated day — e.g. "cat_subscriptions_agorot" or "max_3h_burst_count". */
  topFeature: string;
  /** The human-readable category bucket, when `topFeature` is a category total; null for the three non-category features (total spend, transaction count, burst velocity). */
  topCategory: CategoryBucket | null;
};

export type AnomalyDetectionHandlers = { checkAnomaly(request: AnomalyCheckRequest): Promise<AnomalyCheckResponse> };

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function dateKeyToUtcMidnightMs(dateKey: string): number {
  return Date.UTC(Number(dateKey.slice(0, 4)), Number(dateKey.slice(5, 7)) - 1, Number(dateKey.slice(8, 10)));
}

/** The busiest BURST_WINDOW_MINUTES-wide window's transaction count within one day — mirrors synthesize_ledger.py's `_max_burst_count` exactly (same sliding-window-over-sorted-minutes algorithm), since the model was trained on that exact feature definition. */
function maxBurstCount(minutesOfDay: readonly number[]): number {
  if (minutesOfDay.length === 0) return 0;
  const sorted = [...minutesOfDay].sort((a, b) => a - b);
  let maxCount = 0;
  let left = 0;
  for (let right = 0; right < sorted.length; right++) {
    while (sorted[right] - sorted[left] > BURST_WINDOW_MINUTES) left++;
    maxCount = Math.max(maxCount, right - left + 1);
  }
  return maxCount;
}

type DayBucket = {
  totalAgorot: number;
  count: number;
  minutes: number[];
  categoryTotals: Record<CategoryBucket, number>;
};

function makeEmptyDayBucket(): DayBucket {
  const categoryTotals = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<CategoryBucket, number>;
  return { totalAgorot: 0, count: 0, minutes: [], categoryTotals };
}

/**
 * Aggregates raw transactions into a dense (zero-filled) WINDOW_DAYS x
 * NUM_FEATURES matrix, oldest day first — same "dense, never a gap"
 * discipline `getDailyNetCashFlow` (src/server/dal/transactions.ts,
 * AGENTS.md §3dd) already establishes for a daily series, for the same
 * reason: a silently-skipped day would shift every later day's position,
 * corrupting the feature the model was actually trained to condition on.
 * A transaction whose date falls outside the 30-day window (the caller
 * over-fetched, or passed stale data) is silently ignored rather than
 * throwing — defensive, since this always runs against this app's own
 * DAL output, never adversarial input.
 */
export function buildDailyFeatureMatrix(transactions: readonly RawSpendingTransaction[], windowEndDateKey: string): number[][] {
  if (!DATE_KEY_PATTERN.test(windowEndDateKey)) {
    throw new RangeError(`windowEndDateKey must be an ISO YYYY-MM-DD string, got ${windowEndDateKey}`);
  }

  const windowEndMs = dateKeyToUtcMidnightMs(windowEndDateKey);
  const windowStartMs = windowEndMs - (WINDOW_DAYS - 1) * MS_PER_DAY;

  const dayBuckets: DayBucket[] = Array.from({ length: WINDOW_DAYS }, () => makeEmptyDayBucket());

  for (const txn of transactions) {
    const occurredAt = new Date(txn.occurredAtIso);
    const dateMs = Date.UTC(occurredAt.getUTCFullYear(), occurredAt.getUTCMonth(), occurredAt.getUTCDate());
    const dayIndex = Math.round((dateMs - windowStartMs) / MS_PER_DAY);
    if (dayIndex < 0 || dayIndex >= WINDOW_DAYS) continue;

    const bucket = dayBuckets[dayIndex];
    bucket.totalAgorot += txn.amountAgorot;
    bucket.count += 1;
    bucket.minutes.push(occurredAt.getUTCHours() * 60 + occurredAt.getUTCMinutes());
    bucket.categoryTotals[bucketForCategorySlug(txn.categorySlug)] += txn.amountAgorot;
  }

  return dayBuckets.map((bucket) => [
    bucket.totalAgorot,
    bucket.count,
    maxBurstCount(bucket.minutes),
    ...CATEGORIES.map((c) => bucket.categoryTotals[c]),
  ]);
}

/**
 * log1p, then per-window baseline z-score — must exactly match
 * ml-pipeline/train_autoencoder.py's `normalize_windows()`. Returns a
 * flat, row-major (day-major then feature) Float32Array of length
 * WINDOW_DAYS * NUM_FEATURES, matching the ONNX model's fixed
 * `(1, WINDOW_DAYS, NUM_FEATURES)` input shape.
 */
export function normalizeWindow(matrix: readonly (readonly number[])[]): Float32Array {
  const logMatrix = matrix.map((day) => day.map((v) => Math.log1p(v)));

  const mean = new Array<number>(NUM_FEATURES).fill(0);
  const std = new Array<number>(NUM_FEATURES).fill(1);
  for (let f = 0; f < NUM_FEATURES; f++) {
    const baselineValues = logMatrix.slice(0, BASELINE_DAYS).map((day) => day[f]);
    const m = baselineValues.reduce((sum, v) => sum + v, 0) / baselineValues.length;
    const variance = baselineValues.reduce((sum, v) => sum + (v - m) ** 2, 0) / baselineValues.length;
    const rawStd = Math.sqrt(variance);
    mean[f] = m;
    std[f] = rawStd < 1e-6 ? 1.0 : rawStd;
  }

  const out = new Float32Array(WINDOW_DAYS * NUM_FEATURES);
  for (let d = 0; d < WINDOW_DAYS; d++) {
    for (let f = 0; f < NUM_FEATURES; f++) {
      out[d * NUM_FEATURES + f] = (logMatrix[d][f] - mean[f]) / std[f];
    }
  }
  return out;
}

/**
 * Squared reconstruction error on just the final RECENT_EVAL_DAYS day(s)
 * (mean over the feature dimension) — the anomaly signal itself, plus
 * the per-feature squared errors on that same day for `topContributor`
 * below. Deliberately NOT the whole window's average error — see
 * train_autoencoder.py's `recent_reconstruction_error()` docstring for
 * why averaging across all 30 days empirically diluted a single
 * anomalous day's signal almost to nothing.
 */
function computeAnomalySignal(
  normalizedInput: Float32Array,
  reconstruction: Float32Array,
): { signal: number; lastDayFeatureErrors: number[] } {
  const lastDayStart = (WINDOW_DAYS - RECENT_EVAL_DAYS) * NUM_FEATURES;
  const lastDayFeatureErrors: number[] = [];
  let sumSquaredError = 0;
  for (let f = 0; f < NUM_FEATURES; f++) {
    const idx = lastDayStart + f;
    const diff = reconstruction[idx] - normalizedInput[idx];
    const squaredError = diff * diff;
    lastDayFeatureErrors.push(squaredError);
    sumSquaredError += squaredError;
  }
  return { signal: sumSquaredError / NUM_FEATURES, lastDayFeatureErrors };
}

function classifyTier(signal: number): AnomalyTier {
  if (signal >= THETA_HI) return "HIGH";
  if (signal >= THETA_LO) return "MARGINAL";
  return "NORMAL";
}

function topContributor(lastDayFeatureErrors: readonly number[]): { topFeature: string; topCategory: CategoryBucket | null } {
  let topIndex = 0;
  for (let f = 1; f < lastDayFeatureErrors.length; f++) {
    if (lastDayFeatureErrors[f] > lastDayFeatureErrors[topIndex]) topIndex = f;
  }
  return {
    topFeature: FEATURE_NAMES[topIndex],
    topCategory: topIndex >= 3 ? CATEGORIES[topIndex - 3] : null,
  };
}

/**
 * One fresh session-cache closure per call, mirroring
 * `createForecasterHandlers`'s shape: in production,
 * `anomaly-worker.ts` calls this exactly once per Worker instance, and
 * `anomaly-client.ts` terminates that Worker the moment its one
 * `checkAnomaly` call resolves — this feature runs once per dashboard
 * load, not repeatedly, so there's no "stay warm" case worth optimizing
 * for here.
 */
export function createAnomalyDetectionHandlers(): AnomalyDetectionHandlers {
  let sessionPromise: Promise<ort.InferenceSession> | null = null;

  function getSession(): Promise<ort.InferenceSession> {
    if (!sessionPromise) {
      sessionPromise = (async () => {
        // Same self-hosted WASM runtime forecaster-worker-handlers.ts and
        // local-embedder-worker-handlers.ts already use — the EXACT
        // .asyncify filenames, not left to onnxruntime-web's own default
        // variant selection (this app self-hosts only the asyncify pair
        // under public/onnx-runtime/).
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
    async checkAnomaly(request) {
      const session = await getSession();

      const matrix = buildDailyFeatureMatrix(request.transactions, request.windowEndDateKey);
      const normalizedInput = normalizeWindow(matrix);

      const feeds = { input: new ort.Tensor("float32", normalizedInput, [1, WINDOW_DAYS, NUM_FEATURES]) };
      const results = await session.run(feeds);
      const reconstruction = results.reconstruction.data as Float32Array;

      const { signal, lastDayFeatureErrors } = computeAnomalySignal(normalizedInput, reconstruction);
      const { topFeature, topCategory } = topContributor(lastDayFeatureErrors);

      return {
        tier: classifyTier(signal),
        signal,
        thresholds: { thetaLo: THETA_LO, thetaHi: THETA_HI },
        topFeature,
        topCategory,
      };
    },
  };
}
