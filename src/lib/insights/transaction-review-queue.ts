import { computeRank, type Insight } from "./types";

/** 10+ transactions awaiting review escalates from info to warning. */
const WARNING_COUNT = 10;

export function generateTransactionReviewInsights(needsReviewCount: number): Insight[] {
  if (needsReviewCount <= 0) return [];

  const severity = needsReviewCount >= WARNING_COUNT ? "warning" : "info";
  const plural = needsReviewCount === 1 ? "" : "s";

  return [
    {
      type: "transaction_review_needed",
      severity,
      rank: computeRank(severity, Math.min(needsReviewCount, 99)),
      title: `${needsReviewCount} transaction${plural} ${needsReviewCount === 1 ? "needs" : "need"} review`,
      description: `${needsReviewCount} transaction${plural} ${needsReviewCount === 1 ? "is" : "are"} uncategorized or flagged for manual review.`,
    },
  ];
}
