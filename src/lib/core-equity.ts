import { shareInBps } from "./core-journal";

/**
 * Pure arithmetic for the long-term core's account-value chart (AGENTS.md
 * §3hhh). Takes the series already fetched, in US-dollar cents, and never
 * touches the DAL, like every other `src/lib/` engine (§3b).
 *
 * The account is a US-dollar Alpaca paper account, so the series stays in
 * dollars: converting a historic point at today's shekel rate would blend a
 * currency move into a line that is meant to show only the account.
 */

/** One point per UTC day: the day as `YYYY-MM-DD` and the account value that day, in USD cents. */
export type EquityPoint = { day: string; usdCents: number };

export type EquitySummary = {
  firstDay: string;
  lastDay: string;
  firstUsdCents: number;
  lastUsdCents: number;
  /** Last minus first, in USD cents; negative when the account is down. */
  changeUsdCents: number;
  /** The change as basis points of the first value; null when the first value is not positive. */
  changeBps: number | null;
  /** How many days the points cover, first to last (a gap day counts: 3 points over 10 days is 10). */
  spanDays: number;
};

const DAY_MS = 86_400_000;

function dayToMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/**
 * First-to-last summary of a series, or null when there is nothing to
 * compare (fewer than two points). Expects the points oldest first — the
 * order the DAL returns them in — and does not re-sort: a series that is
 * out of order is a bug to see, not to hide.
 *
 * This is "change since the first snapshot", NOT a return: the snapshots
 * are account values, and a deposit or a reset of the paper account would
 * show up as a jump in them. The router funds the account once and does
 * not top it up, so for this account the two agree; the page says so
 * rather than relying on that.
 */
export function summarizeEquity(points: readonly EquityPoint[]): EquitySummary | null {
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const changeUsdCents = last.usdCents - first.usdCents;
  return {
    firstDay: first.day,
    lastDay: last.day,
    firstUsdCents: first.usdCents,
    lastUsdCents: last.usdCents,
    changeUsdCents,
    changeBps: shareInBps(changeUsdCents, first.usdCents),
    spanDays: Math.round((dayToMs(last.day) - dayToMs(first.day)) / DAY_MS),
  };
}
