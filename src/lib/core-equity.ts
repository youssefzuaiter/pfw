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

/**
 * What the core is compared against (AGENTS.md §3mmm): one broad, cheap
 * whole-world index fund, the "do nothing clever" alternative to a mix.
 */
export const CORE_BENCHMARK = { symbol: "VT", name: "Vanguard Total World Stock ETF" } as const;

/** A benchmark price, keyed by the UTC day of the trade it came from. Oldest first, one per day. */
export type BenchmarkQuote = { day: string; priceUsd: number };

export type BenchmarkPoint = EquityPoint & {
  /** What the account's value on the first compared day would be worth in the benchmark; null where there is no price. */
  benchmarkUsdCents: number | null;
};

export type BenchmarkSummary = {
  sinceDay: string;
  lastDay: string;
  /** The benchmark's change over the compared days, as basis points of the starting amount. */
  benchmarkChangeBps: number | null;
  /** The account's change over the SAME days — not `EquitySummary.changeBps`, which can start earlier. */
  accountChangeBps: number | null;
};

/** A price older than this is not carried forward: a long outage of the quote sync shows as a gap, not a flat line. */
export const MAX_BENCHMARK_QUOTE_AGE_DAYS = 5;

/** One price per UTC day of the trade, keeping the latest observation of a day. Expects the rows oldest first. */
export function toDailyBenchmarkQuotes(rows: readonly { observedAt: Date; priceUsd: number }[]): BenchmarkQuote[] {
  const byDay = new Map<string, number>();
  for (const row of rows) byDay.set(row.observedAt.toISOString().slice(0, 10), row.priceUsd);
  return [...byDay.entries()].map(([day, priceUsd]) => ({ day, priceUsd }));
}

/**
 * The account next to the same starting amount in the benchmark. The start
 * is the first account day with a benchmark price on or before it; from
 * there each day's benchmark value is the starting amount scaled by the
 * benchmark's price change. Days before the start, and days whose latest
 * price is more than `MAX_BENCHMARK_QUOTE_AGE_DAYS` old, have none.
 *
 * Both lines start at the same amount on the same day, so the gap between
 * them is the difference in what the money did, not in how much there was.
 */
export function compareWithBenchmark(
  points: readonly EquityPoint[],
  quotes: readonly BenchmarkQuote[],
): { points: BenchmarkPoint[]; summary: BenchmarkSummary | null } {
  let quoteIndex = -1;
  let base: { day: string; usdCents: number; priceUsd: number } | null = null;

  const compared = points.map((point): BenchmarkPoint => {
    while (quoteIndex + 1 < quotes.length && quotes[quoteIndex + 1].day <= point.day) quoteIndex += 1;
    const quote = quoteIndex >= 0 ? quotes[quoteIndex] : null;
    const fresh =
      quote !== null &&
      quote.priceUsd > 0 &&
      (dayToMs(point.day) - dayToMs(quote.day)) / DAY_MS <= MAX_BENCHMARK_QUOTE_AGE_DAYS;
    if (!fresh) return { ...point, benchmarkUsdCents: null };
    if (!base) base = { day: point.day, usdCents: point.usdCents, priceUsd: quote.priceUsd };
    return { ...point, benchmarkUsdCents: Math.round((base.usdCents * quote.priceUsd) / base.priceUsd) };
  });

  const withBenchmark = compared.filter((point) => point.benchmarkUsdCents !== null);
  if (!base || withBenchmark.length < 2) return { points: compared, summary: null };
  const start: { day: string; usdCents: number } = base;
  const last = withBenchmark[withBenchmark.length - 1];
  return {
    points: compared,
    summary: {
      sinceDay: start.day,
      lastDay: last.day,
      benchmarkChangeBps: shareInBps((last.benchmarkUsdCents as number) - start.usdCents, start.usdCents),
      accountChangeBps: shareInBps(last.usdCents - start.usdCents, start.usdCents),
    },
  };
}
