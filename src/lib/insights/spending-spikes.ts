import { agorot, formatAgorot, type Agorot } from "../money";
import { mean, standardDeviation } from "../stats";
import { computeRank, type Insight } from "./types";

/** Need at least this many prior months to have a meaningful baseline — otherwise "spike vs. what?" is unanswerable. */
const MIN_HISTORY_MONTHS = 2;
const SPIKE_STDDEV_MULTIPLIER = 1.5;
/** Current-month spend more than double the recent average escalates from warning to critical. */
const CRITICAL_PERCENT_ABOVE_AVERAGE = 100;

export type CategorySpendHistory = {
  categoryId: string;
  categoryName: string;
  /** Positive magnitude. */
  currentMonthSpend: Agorot;
  /** Positive magnitudes, most-recent-first or in any order — order doesn't matter for the statistics. */
  priorMonthsSpend: readonly Agorot[];
};

/**
 * Flags a category whose spend this month is both above its recent
 * average AND further above that average than typical month-to-month
 * variation would explain (mean + 1.5 standard deviations) — a
 * statistical outlier, not a category that's simply always a bit noisy.
 */
export function generateSpendingSpikeInsights(histories: readonly CategorySpendHistory[]): Insight[] {
  const insights: Insight[] = [];

  for (const history of histories) {
    if (history.priorMonthsSpend.length < MIN_HISTORY_MONTHS) continue;

    const average = mean(history.priorMonthsSpend);
    const threshold = average + SPIKE_STDDEV_MULTIPLIER * standardDeviation(history.priorMonthsSpend);

    if (history.currentMonthSpend <= average || history.currentMonthSpend <= threshold) continue;

    const percentAboveAverage = average > 0 ? ((history.currentMonthSpend - average) / average) * 100 : 100;
    const severity = percentAboveAverage > CRITICAL_PERCENT_ABOVE_AVERAGE ? "critical" : "warning";

    insights.push({
      type: "spending_spike",
      severity,
      rank: computeRank(severity, percentAboveAverage),
      title: `Unusual spending spike in ${history.categoryName}`,
      description: `Spent ${formatAgorot(history.currentMonthSpend)} this month, ${Math.round(percentAboveAverage)}% above the recent average of ${formatAgorot(agorot(Math.round(average)))}.`,
      relatedEntityId: history.categoryId,
    });
  }

  return insights;
}
