import { addAgorot, agorot, multiplyAgorot, type Agorot } from "./money";

/**
 * Burn-rate half of the Real-Time Liquidity Runway & Burn-Rate Engine
 * (AGENTS.md §3v). Pure function over already-fetched data, same
 * `src/lib/` convention as every other engine (§3b).
 */

export type MonthlyExpense = {
  /** "YYYY-MM", matching `getMonthlyIncomeExpenseHistory`'s existing shape (src/server/dal/transactions.ts) — reused as-is rather than duplicated, since "burn" is exactly "monthly expense," not a separately-tagged subset (see this module's own header for why no new essential/discretionary category split was introduced). */
  monthKey: string;
  /** A positive magnitude — this app's existing convention for a monthly expense total (see `getMonthlyIncomeExpenseHistory`'s own doc comment). */
  expenseAgorot: Agorot;
};

export type BurnRateResult = {
  monthlyBurnRateAgorot: Agorot;
  /** Which figure actually determined the result — surfaced so the UI can explain itself ("based on your last 3 months" vs "based on your known recurring bills") rather than presenting one opaque number. */
  source: "historical_average" | "recurring_commitments_floor" | "none";
  /** How many months of history actually went into the average (<= the requested `trailingMonths`) — 0 when there was no history to average at all. */
  monthsAveraged: number;
};

const DEFAULT_TRAILING_MONTHS = 3;

/**
 * Burn rate = the larger of (a) a trailing rolling average of actual
 * monthly expense history, and (b) known active recurring commitments
 * (the subscription radar's cash-drag total, `src/lib/subscription-
 * radar.ts`'s `calculateCashDrag`) — never LESS than (b), because a
 * currently-active recurring bill is real committed spend regardless of
 * whether it happens to be under-represented in a short or unusually
 * quiet transaction history window. This is also what makes the
 * function well-behaved for a brand-new account with little or no
 * transaction history yet: it still reports a meaningful floor instead
 * of a misleadingly-low (or zero) burn rate.
 *
 * Deliberately uses TOTAL monthly expense, not a new "essential vs.
 * discretionary" category split — the task's "monthly essential
 * expenses" is read here as "your regular committed monthly outflow"
 * (the standard meaning of "burn rate" in a runway calculation), not as
 * a request to invent and maintain a new per-category taxonomy this app
 * has no other use for. `recurringCommitmentsMonthlyAgorot` already
 * captures the "committed, not discretionary, happens whether you think
 * about it or not" half of that distinction.
 *
 * Only the most recent `trailingMonths` entries of `monthlyExpenseHistory`
 * are used (it may contain more) — `monthlyExpenseHistory` MUST already
 * be sorted ascending by `monthKey`, matching
 * `getMonthlyIncomeExpenseHistory`'s own returned order; this function
 * trusts that rather than re-sorting, since re-sorting a caller's
 * already-correct data is wasted work, not a correctness improvement.
 */
export function calculateMonthlyBurnRate(
  monthlyExpenseHistory: readonly MonthlyExpense[],
  recurringCommitmentsMonthlyAgorot: Agorot,
  options: { trailingMonths?: number } = {},
): BurnRateResult {
  const trailingMonths = options.trailingMonths ?? DEFAULT_TRAILING_MONTHS;
  if (!Number.isInteger(trailingMonths) || trailingMonths < 1) {
    throw new RangeError(`trailingMonths must be a positive integer, received ${trailingMonths}`);
  }

  const window = monthlyExpenseHistory.slice(-trailingMonths);
  const historicalAverageAgorot =
    window.length > 0
      ? multiplyAgorot(addAgorot(...window.map((m) => m.expenseAgorot)), 1 / window.length)
      : agorot(0);

  if (historicalAverageAgorot >= recurringCommitmentsMonthlyAgorot) {
    return {
      monthlyBurnRateAgorot: historicalAverageAgorot,
      source: historicalAverageAgorot > 0 ? "historical_average" : "none",
      monthsAveraged: window.length,
    };
  }

  return {
    monthlyBurnRateAgorot: recurringCommitmentsMonthlyAgorot,
    source: "recurring_commitments_floor",
    monthsAveraged: window.length,
  };
}
