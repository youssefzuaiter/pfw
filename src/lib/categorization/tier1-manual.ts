import type { CategorySuggestion, PastOccurrence } from "./types";

/** Below this level of agreement among past manual corrections, Tier 1 declines rather than guess. */
const MIN_AGREEMENT = 0.8;

/**
 * Tier 1 — manual user corrections. If the user has previously
 * (re)categorized transactions from this same merchant by hand, and those
 * corrections agree strongly on one category, trust it outright. This is
 * what "inline recategorisation training" (the /transactions screen)
 * feeds: every manual recategorization becomes a future Tier 1 hit for
 * the same merchant.
 */
export function findManualCorrection(occurrences: readonly PastOccurrence[]): CategorySuggestion | null {
  const manual = occurrences.filter((o) => o.isManual);
  if (manual.length === 0) return null;

  const counts = new Map<string, number>();
  for (const { categoryId } of manual) {
    counts.set(categoryId, (counts.get(categoryId) ?? 0) + 1);
  }

  const [topCategoryId, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const confidence = topCount / manual.length;

  if (confidence < MIN_AGREEMENT) return null;

  return {
    categoryId: topCategoryId,
    confidence,
    tier: 1,
    reason: `${topCount}/${manual.length} past manual corrections for this merchant agree`,
  };
}
