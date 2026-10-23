import "server-only";
import { cache } from "react";
import { monthKeyToExclusiveEndDate, monthKeyToStartDate, shiftMonthKey } from "../../lib/date-month";
import { formatReportingMinorUnits } from "../../lib/reporting-currency";
import { buildSpendingTrends, TREND_WINDOW_MONTHS, type CategoryTrend, type SpendingTrends } from "../../lib/spending-trends";
import { listAllCategories } from "../dal/categories";
import { listRealMoneyFlowsInRange } from "../dal/transactions";
import { getReportingContext } from "../reporting/reporting-context";

/** A category's trend with its name and every figure already as text in the reporting currency. */
export type CategoryTrendRow = CategoryTrend & {
  name: string;
  thisMonthText: string;
  usualByNowText: string;
  differenceText: string;
  lastMonthText: string;
};

export type SpendingTrendsView = Omit<SpendingTrends, "categories" | "biggestRises" | "biggestFalls"> & {
  categories: CategoryTrendRow[];
  biggestRises: CategoryTrendRow[];
  biggestFalls: CategoryTrendRow[];
  thisMonthText: string;
  usualByNowText: string;
  differenceText: string;
  /** The difference without its sign, for "spent X more" / "X less". */
  differenceAbsText: string;
  monthsText: { monthKey: string; spendText: string }[];
};

/**
 * Everything the spending-trends page shows (AGENTS.md §3iiii): the last six
 * months of spending by category (a split transaction counts in each of its
 * categories, transfers are left out), compared fairly with the same days of
 * the earlier months. `cache()`-wrapped per request like every other
 * `build-*` aggregator; `asOf` is injectable for tests.
 */
export const buildSpendingTrendsView = cache(async (userId: string, asOf: Date = new Date()): Promise<SpendingTrendsView> => {
  const monthKey = asOf.toISOString().slice(0, 7);
  const from = monthKeyToStartDate(shiftMonthKey(monthKey, -(TREND_WINDOW_MONTHS - 1)));
  const to = monthKeyToExclusiveEndDate(monthKey);

  const [flows, categories, reporting] = await Promise.all([
    listRealMoneyFlowsInRange(userId, from, to),
    listAllCategories(userId),
    getReportingContext(userId),
  ]);

  const trends = buildSpendingTrends({ flows, context: reporting, asOf });
  const names = new Map(categories.map((category) => [category.id, category.name]));
  const money = (minorUnits: number, signed = false) => formatReportingMinorUnits(minorUnits, reporting, { showPositiveSign: signed });
  const toRow = (trend: CategoryTrend): CategoryTrendRow => ({
    ...trend,
    name: names.get(trend.categoryId) ?? "Other",
    thisMonthText: money(trend.thisMonth),
    usualByNowText: money(trend.usualByNow),
    differenceText: money(trend.difference, true),
    lastMonthText: money(trend.lastMonth),
  });

  return {
    ...trends,
    categories: trends.categories.map(toRow),
    biggestRises: trends.biggestRises.map(toRow),
    biggestFalls: trends.biggestFalls.map(toRow),
    thisMonthText: money(trends.thisMonth),
    usualByNowText: money(trends.usualByNow),
    differenceText: money(trends.difference, true),
    differenceAbsText: money(Math.abs(trends.difference)),
    monthsText: trends.months.map((month) => ({ monthKey: month.monthKey, spendText: money(month.spend) })),
  };
});
