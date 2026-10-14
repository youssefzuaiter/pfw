import "server-only";
import { cache } from "react";
import {
  CORE_BENCHMARK,
  MAX_BENCHMARK_QUOTE_AGE_DAYS,
  compareWithBenchmark,
  toDailyBenchmarkQuotes,
  type BenchmarkSummary,
} from "../../lib/core-equity";
import { monthKeyToExclusiveEndDate, monthKeyToStartDate, shiftMonthKey } from "../../lib/date-month";
import { listCoreEquitySeries } from "../dal/core-mirror";
import { listEquityQuoteHistory } from "../dal/equity-quotes";
import { getMonthlyIncomeExpenseHistory, listLargestExpensesInRange, listRealMoneyFlowsInRange } from "../dal/transactions";
import { ILS_REPORTING, incomeExpenseByMonthInReporting } from "../../lib/reporting-currency";
import { gatherMonthlyReport, type MonthlyReportData } from "./monthly-report";

/** How many of the month's largest expenses the page lists. */
export const LARGEST_EXPENSES_SHOWN = 5;

/** Enough to list every category a personal ledger has. */
const ALL_CATEGORIES = 100;

const DAY_MS = 86_400_000;

export type MonthlyReview = {
  report: MonthlyReportData;
  /** The month before, for comparison; `*Shown` in the reporting currency, per transaction on its own day (AGENTS.md §3vvv). */
  previous: { incomeAgorot: bigint; expenseAgorot: bigint; incomeShown: number; expenseShown: number };
  largestExpenses: Awaited<ReturnType<typeof listLargestExpensesInRange>>;
  /** The core against VT over the same days of this month, or null without enough data (AGENTS.md §3mmm). */
  coreBenchmark: BenchmarkSummary | null;
};

/**
 * Everything the monthly review page shows for one month (AGENTS.md §3ppp).
 * The month's figures come from the same `gatherMonthlyReport` the email
 * uses, so the page and the email cannot disagree; the page adds every
 * category, the previous month, the largest expenses and the benchmark.
 * `cache()`-wrapped per request, like every other `build-*` aggregator.
 */
export const buildMonthlyReview = cache(async (userId: string, monthKey: string): Promise<MonthlyReview> => {
  const from = monthKeyToStartDate(monthKey);
  const to = monthKeyToExclusiveEndDate(monthKey);
  const previousKey = shiftMonthKey(monthKey, -1);

  const [report, previousHistory, previousFlows, largestExpenses, coreSeries, benchmarkRows] = await Promise.all([
    gatherMonthlyReport(userId, monthKey, { categoryLimit: ALL_CATEGORIES }),
    getMonthlyIncomeExpenseHistory(userId, monthKeyToStartDate(previousKey), from),
    listRealMoneyFlowsInRange(userId, monthKeyToStartDate(previousKey), from),
    listLargestExpensesInRange(userId, from, to, LARGEST_EXPENSES_SHOWN),
    listCoreEquitySeries(userId, to, 45),
    // A few days before the month, so its first day can use a price from just before it.
    listEquityQuoteHistory(CORE_BENCHMARK.symbol, new Date(from.getTime() - MAX_BENCHMARK_QUOTE_AGE_DAYS * DAY_MS)),
  ]);

  const previousMonth = previousHistory.find((bucket) => bucket.monthKey === previousKey);
  const previousShown = incomeExpenseByMonthInReporting(previousFlows, report.reporting ?? ILS_REPORTING).get(previousKey);
  const monthPoints = coreSeries
    .filter((point) => point.takenAt >= from && point.takenAt < to)
    .map((point) => ({ day: point.takenAt.toISOString().slice(0, 10), usdCents: point.equityUsdCents }));

  return {
    report,
    previous: {
      incomeAgorot: previousMonth?.incomeAgorot ?? 0n,
      expenseAgorot: previousMonth?.expenseAgorot ?? 0n,
      incomeShown: previousShown?.income ?? 0,
      expenseShown: previousShown?.expense ?? 0,
    },
    largestExpenses,
    coreBenchmark: compareWithBenchmark(monthPoints, toDailyBenchmarkQuotes(benchmarkRows)).summary,
  };
});
