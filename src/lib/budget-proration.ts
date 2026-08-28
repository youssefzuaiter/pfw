import type { Agorot } from "./money";

/**
 * Month-progress proration (spec: "month-progress proration"): compares
 * how far through the month you are against how much of the budget is
 * spent, so a budget at 60% utilization on day 10 of a 30-day month
 * reads very differently from the same 60% on day 28.
 */

export type ProrationStatus = "under_pace" | "on_pace" | "over_pace";

/** Fraction of the calendar month elapsed as of `asOf`, in [1/daysInMonth, 1]. */
export function computeMonthProgress(asOf: Date): number {
  const daysInMonth = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() + 1, 0)).getUTCDate();
  return asOf.getUTCDate() / daysInMonth;
}

const PACE_TOLERANCE = 0.1; // 10 percentage points either side of "exactly on pace" still counts as on pace.

export function computeProrationStatus(
  spentThisMonth: Agorot,
  monthlyLimit: Agorot,
  monthProgress: number,
): ProrationStatus {
  if (monthlyLimit <= 0) return "on_pace";

  const spendProgress = spentThisMonth / monthlyLimit;
  const diff = spendProgress - monthProgress;

  if (diff > PACE_TOLERANCE) return "over_pace";
  if (diff < -PACE_TOLERANCE) return "under_pace";
  return "on_pace";
}
