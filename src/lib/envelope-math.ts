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
 * "Available to budget" — the cash that has not been given a job yet:
 * what is in your accounts, minus what your cards owe, minus what already
 * sits in envelopes (AGENTS.md §3rrrr). These are the first three lines of
 * Safe to Spend, so the two always reconcile: Safe to Spend is this figure less
 * the bills, debts and goals still to come.
 *
 * It used to be all income ever received minus all allocations, which ignored
 * every shekel spent outside an envelope and so could show $1,770 against $721
 * of real cash. The zero-sum rule is only worth having if it cannot let you
 * budget money you do not have.
 *
 * Negative means more is set aside than the cash covers.
 */
export function computeAvailableToBudget(input: {
  cashAgorot: Agorot;
  cardOwedAgorot: Agorot;
  /** The positive envelope balances only: an overdrawn envelope's overspend is already out of cash. */
  envelopeReserveAgorot: Agorot;
}): Agorot {
  return agorot(input.cashAgorot - input.cardOwedAgorot - input.envelopeReserveAgorot);
}

/** The positive balances of a set of envelopes: what is already set aside. */
export function sumEnvelopeReserve(balancesAgorot: readonly number[]): Agorot {
  return agorot(balancesAgorot.reduce((sum, balance) => sum + (balance > 0 ? balance : 0), 0));
}

/**
 * How much more cash an allocation sets aside. Not the raw change: lifting an
 * overdrawn envelope from -100 to 0 sets nothing aside, because the overspend
 * already came out of cash. Negative when the allocation is reduced.
 */
export function reserveIncrease(balanceAgorot: number, deltaAgorot: number): number {
  return Math.max(0, balanceAgorot + deltaAgorot) - Math.max(0, balanceAgorot);
}

/** Setting less aside is always allowed; setting more aside needs the cash for it. */
export function allocationFits(increaseAgorot: number, availableAgorot: number): boolean {
  return increaseAgorot <= 0 || increaseAgorot <= availableAgorot;
}
