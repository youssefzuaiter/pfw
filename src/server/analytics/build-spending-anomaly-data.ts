import "server-only";
import { cache } from "react";
import { getRecentExpenseTransactionsForAnomalyDetection, type SpendingAnomalyTransactionRow } from "../dal/transactions";

const WINDOW_DAYS = 30; // must match src/lib/ml/anomaly-worker-handlers.ts's WINDOW_DAYS

export type SpendingAnomalyData = {
  transactions: SpendingAnomalyTransactionRow[];
  /** ISO `YYYY-MM-DD` — today, the last day of the trailing WINDOW_DAYS-day window the client Worker evaluates. */
  windowEndDateKey: string;
};

/**
 * Assembles the one input `SpendingAnomalyAlert`
 * (src/app/dashboard/_components/spending-anomaly-alert.tsx) hands to
 * the anomaly-detection Worker — the caller's trailing WINDOW_DAYS-day
 * expense history, fetched through the RLS-enforced DAL
 * (getRecentExpenseTransactionsForAnomalyDetection, which itself goes
 * through withUserScope, same as every other DAL function in this app).
 * Deliberately does NOT run any detection itself — like
 * build-runway-forecast-data.ts, the actual inference (ONNX model
 * preprocessing + reconstruction-error thresholding) only ever runs
 * client-side, so this function's whole job is fetching and shaping real
 * data, nothing more. `cache()`-wrapped for the same per-request-only
 * reason every other `build-*-data.ts` aggregator uses it (AGENTS.md
 * §3c) — this is live, per-user financial data, never a cross-request
 * cache.
 */
export const buildSpendingAnomalyData = cache(async (userId: string): Promise<SpendingAnomalyData> => {
  const now = new Date();
  const windowEndDateKey = now.toISOString().slice(0, 10);

  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - (WINDOW_DAYS - 1));
  from.setUTCHours(0, 0, 0, 0);

  const transactions = await getRecentExpenseTransactionsForAnomalyDetection(userId, from, now);

  return { transactions, windowEndDateKey };
});
