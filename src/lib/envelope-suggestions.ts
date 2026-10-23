/**
 * Suggested monthly amounts for envelopes, from what each category actually
 * cost in recent months (AGENTS.md §3mmmm). Pure: the caller supplies totals.
 *
 * A suggestion is the average monthly spend over the months that have any
 * activity at all, rounded UP to a whole `ROUND_UP_TO_AGOROT` (₪10), so a
 * budget is never set just under what the category usually costs. Months before
 * the user's first transaction are not counted as zero spending, or the
 * average of a new account would be far too low.
 */

/** How many complete months before the month being budgeted are looked at. */
export const SUGGESTION_MONTHS = 3;

/** Suggestions are rounded up to this many agorot (₪10). */
export const ROUND_UP_TO_AGOROT = 1_000;

export type EnvelopeSuggestion = {
  categoryId: string;
  /** What the category cost per month on average, rounded to an agorah. */
  averageAgorot: number;
  /** The average rounded up to the next ₪10. */
  suggestedAgorot: number;
};

/**
 * @param totals each category's spending summed over the months considered,
 *   positive agorot.
 * @param monthsWithActivity how many of those months had any transaction;
 *   with none there is no history to suggest from.
 */
export function suggestEnvelopeAmounts(totals: ReadonlyMap<string, number>, monthsWithActivity: number): EnvelopeSuggestion[] {
  if (monthsWithActivity <= 0) return [];
  const suggestions: EnvelopeSuggestion[] = [];
  for (const [categoryId, total] of totals) {
    if (total <= 0) continue;
    const averageAgorot = Math.round(total / monthsWithActivity);
    if (averageAgorot <= 0) continue;
    suggestions.push({ categoryId, averageAgorot, suggestedAgorot: Math.ceil(averageAgorot / ROUND_UP_TO_AGOROT) * ROUND_UP_TO_AGOROT });
  }
  return suggestions.sort((a, b) => b.suggestedAgorot - a.suggestedAgorot || a.categoryId.localeCompare(b.categoryId));
}
