import { formatAgorot } from "../money";
import type { RecurringDetectionResult } from "../recurring-detection";
import { computeRank, type Insight } from "./types";

/**
 * Surfaces merchants the periodicity engine flagged as recurring.
 * De-duplicating against ones the user has already seen/acknowledged is
 * a stateful DAL concern (Phase 4) — this function is a pure mapping
 * from "detected recurring" to "insight," called with whatever subset
 * the caller has decided is newsworthy.
 */
export function generateRecurringChargeInsights(
  results: readonly RecurringDetectionResult[],
  merchantNameByKey: (merchantKey: string) => string,
): Insight[] {
  return results
    .filter((r) => r.isRecurring)
    .map((r) => {
      const intervalDays = Math.round(r.averageIntervalDays ?? 30);
      return {
        type: "recurring_charge_detected" as const,
        severity: "info" as const,
        rank: computeRank("info", 10),
        title: `Recurring charge detected: ${merchantNameByKey(r.merchantKey)}`,
        description: `About ${formatAgorot(r.averageAmount)} approximately every ${intervalDays} days.`,
        relatedEntityId: r.merchantKey,
      };
    });
}
