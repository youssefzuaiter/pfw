import { compareMonthKeys } from "./date-month";
import { agorot, type Agorot } from "./money";

/**
 * Zero-Sum Envelope Budgeting's pure math — same `src/lib/` convention
 * as every other engine in this app (AGENTS.md §3b): takes already-
 * fetched data as input, never touches the DAL/DB itself, so it's
 * directly testable with plain data literals. `src/server/dal/envelopes.ts`
 * is what fetches the per-month allocation/spend breakdown these
 * functions consume.
 */

export type MonthlyEnvelopeActivity = {
  /** `YYYY-MM`. */
  month: string;
  /** Sum of allocations made IN this specific month (not cumulative). */
  allocatedAgorot: Agorot;
  /** Sum of expense magnitude IN this specific month (not cumulative), always >= 0. */
  spentAgorot: Agorot;
};

/**
 * The rolling envelope balance as of `month`: every allocation up to and
 * including `month`, minus every expense from the envelope's FIRST
 * allocation month up to and including `month`.
 * This single cumulative-sum computation is what "carries forward
 * unspent funds to the next month" and "deducts overspending" both
 * reduce to — neither is a special case handled separately. A month
 * that spent more than it was allocated simply contributes a negative
 * delta to the running total, which the next month's balance inherits
 * exactly like a positive (unspent) delta would.
 *
 * An envelope begins the month money is first put into it. Spending a
 * category had before that was never drawn from this envelope, so it is not
 * a deficit against it: a category spent in for months and only now given a
 * budget starts from its first allocation, not from a hole. A category that
 * has never been allocated to has no envelope at all, so its balance is 0
 * (what it spent is still reported as spending, just not as an overdraft).
 */
export function computeRollingBalance(activity: readonly MonthlyEnvelopeActivity[], month: string): Agorot {
  const startsAt = activity
    .filter((entry) => entry.allocatedAgorot !== 0 && compareMonthKeys(entry.month, month) <= 0)
    .map((entry) => entry.month)
    .sort(compareMonthKeys)[0];
  if (startsAt === undefined) return agorot(0);

  let allocated = 0;
  let spent = 0;
  for (const entry of activity) {
    if (compareMonthKeys(entry.month, month) > 0) continue;
    allocated += entry.allocatedAgorot;
    if (compareMonthKeys(entry.month, startsAt) >= 0) spent += entry.spentAgorot;
  }
  return agorot(allocated - spent);
}

/**
 * "Ready to assign" — real income received up to and including `month`,
 * minus every allocation made up to and including `month`, across every
 * envelope. The zero-sum rule (Phase 3) is enforced by never letting a
 * new allocation push the total allocated past this figure.
 */
export function computeAvailableToBudget(totalIncomeAgorot: Agorot, totalAllocatedAgorot: Agorot): Agorot {
  return agorot(totalIncomeAgorot - totalAllocatedAgorot);
}
