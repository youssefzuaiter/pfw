import "server-only";
import { monthKeyToExclusiveEndDate, monthKeyToStartDate } from "../../lib/date-month";
import { listAllCategories } from "../dal/categories";
import { listCoreEquitySeries } from "../dal/core-mirror";
import { getNetWorthSnapshotsInRange } from "../dal/net-worth";
import { getMonthlyIncomeExpenseHistory, getSpendByCategoryInRange, listRealMoneyFlowsInRange } from "../dal/transactions";
import { getReportingContext } from "../reporting/reporting-context";
import {
  incomeExpenseByMonthInReporting,
  spendByCategoryInReporting,
  toReportingMinorUnitsOn,
  type ReportingContext,
} from "../../lib/reporting-currency";

/** How many categories the report lists by spend. */
export const TOP_CATEGORY_COUNT = 5;

export type MonthlyReportData = {
  /** `YYYY-MM`. */
  monthKey: string;
  incomeAgorot: bigint;
  expenseAgorot: bigint;
  /**
   * The same in the reporting currency's minor units (AGENTS.md §3vvv): every
   * transaction converted on its own day, then added, so the categories and
   * the totals agree wherever they are shown. Equal to the agorot for ILS.
   */
  incomeShown: number;
  expenseShown: number;
  topCategories: { name: string; spentAgorot: bigint; spentShown: number }[];
  /** The month's first and last net-worth snapshot, or null with fewer than two; `*Shown` each at its own day's rate. */
  netWorth: { startAgorot: bigint; endAgorot: bigint; startShown: number; endShown: number } | null;
  /** The long-term core's first and last daily value in the month, or null with fewer than two. */
  core: { startUsdCents: number; endUsdCents: number } | null;
  /** The user's reporting currency at send time (AGENTS.md §3nnn); absent means ILS. */
  reporting?: ReportingContext;
};

/**
 * Everything one monthly report shows (AGENTS.md §3lll), read through the
 * same user-scoped DAL functions the dashboard uses, so the email and the
 * screens agree. Income and spending exclude transfers between the user's
 * own accounts (REAL_MONEY inside those functions). The email lists the top
 * five categories; the review page (§3ppp) passes a larger `categoryLimit`.
 */
export async function gatherMonthlyReport(
  userId: string,
  monthKey: string,
  options: { categoryLimit?: number } = {},
): Promise<MonthlyReportData> {
  const from = monthKeyToStartDate(monthKey);
  const to = monthKeyToExclusiveEndDate(monthKey);

  const [history, spend, categories, snapshots, coreSeries, reporting, flows] = await Promise.all([
    getMonthlyIncomeExpenseHistory(userId, from, to),
    getSpendByCategoryInRange(userId, from, to),
    listAllCategories(userId),
    getNetWorthSnapshotsInRange(userId, from, to),
    // The window reaches back from the month's end; points after it are dropped below.
    listCoreEquitySeries(userId, to, 45),
    getReportingContext(userId),
    listRealMoneyFlowsInRange(userId, from, to),
  ]);
  const shownMonth = incomeExpenseByMonthInReporting(flows, reporting).get(monthKey);
  const shownByCategory = spendByCategoryInReporting(flows, reporting);

  const month = history.find((bucket) => bucket.monthKey === monthKey);
  const nameById = new Map(categories.map((category) => [category.id, category.name]));
  const topCategories = spend
    .filter((row) => row.totalAgorot > 0n)
    .sort((a, b) => (b.totalAgorot > a.totalAgorot ? 1 : b.totalAgorot < a.totalAgorot ? -1 : 0))
    .slice(0, options.categoryLimit ?? TOP_CATEGORY_COUNT)
    .map((row) => ({
      name: nameById.get(row.categoryId) ?? "Unknown category",
      spentAgorot: row.totalAgorot,
      spentShown: shownByCategory.get(row.categoryId) ?? 0,
    }));

  const corePoints = coreSeries.filter((point) => point.takenAt >= from && point.takenAt < to);

  return {
    monthKey,
    reporting,
    incomeAgorot: month?.incomeAgorot ?? 0n,
    expenseAgorot: month?.expenseAgorot ?? 0n,
    incomeShown: shownMonth?.income ?? 0,
    expenseShown: shownMonth?.expense ?? 0,
    topCategories,
    netWorth: snapshots.length >= 2 ? netWorthChange(snapshots[0], snapshots[snapshots.length - 1], reporting) : null,
    core:
      corePoints.length >= 2
        ? { startUsdCents: corePoints[0].equityUsdCents, endUsdCents: corePoints[corePoints.length - 1].equityUsdCents }
        : null,
  };
}

type Snapshot = { snapshotDate: Date; netWorthAgorot: bigint };

/** First and last snapshot, each also in the reporting currency at the rate of its own day. */
function netWorthChange(start: Snapshot, end: Snapshot, reporting: ReportingContext) {
  return {
    startAgorot: start.netWorthAgorot,
    endAgorot: end.netWorthAgorot,
    startShown: toReportingMinorUnitsOn(start.netWorthAgorot, start.snapshotDate, reporting),
    endShown: toReportingMinorUnitsOn(end.netWorthAgorot, end.snapshotDate, reporting),
  };
}
