import "server-only";
import { monthKeyToExclusiveEndDate, monthKeyToStartDate } from "../../lib/date-month";
import { listAllCategories } from "../dal/categories";
import { listCoreEquitySeries } from "../dal/core-mirror";
import { getNetWorthSnapshotsInRange } from "../dal/net-worth";
import { getMonthlyIncomeExpenseHistory, getSpendByCategoryInRange } from "../dal/transactions";

/** How many categories the report lists by spend. */
export const TOP_CATEGORY_COUNT = 5;

export type MonthlyReportData = {
  /** `YYYY-MM`. */
  monthKey: string;
  incomeAgorot: bigint;
  expenseAgorot: bigint;
  topCategories: { name: string; spentAgorot: bigint }[];
  /** The month's first and last net-worth snapshot, or null with fewer than two. */
  netWorth: { startAgorot: bigint; endAgorot: bigint } | null;
  /** The long-term core's first and last daily value in the month, or null with fewer than two. */
  core: { startUsdCents: number; endUsdCents: number } | null;
};

/**
 * Everything one monthly report shows (AGENTS.md §3lll), read through the
 * same user-scoped DAL functions the dashboard uses, so the email and the
 * screens agree. Income and spending exclude transfers between the user's
 * own accounts (REAL_MONEY inside those functions).
 */
export async function gatherMonthlyReport(userId: string, monthKey: string): Promise<MonthlyReportData> {
  const from = monthKeyToStartDate(monthKey);
  const to = monthKeyToExclusiveEndDate(monthKey);

  const [history, spend, categories, snapshots, coreSeries] = await Promise.all([
    getMonthlyIncomeExpenseHistory(userId, from, to),
    getSpendByCategoryInRange(userId, from, to),
    listAllCategories(userId),
    getNetWorthSnapshotsInRange(userId, from, to),
    // The window reaches back from the month's end; points after it are dropped below.
    listCoreEquitySeries(userId, to, 45),
  ]);

  const month = history.find((bucket) => bucket.monthKey === monthKey);
  const nameById = new Map(categories.map((category) => [category.id, category.name]));
  const topCategories = spend
    .filter((row) => row.totalAgorot > 0n)
    .sort((a, b) => (b.totalAgorot > a.totalAgorot ? 1 : b.totalAgorot < a.totalAgorot ? -1 : 0))
    .slice(0, TOP_CATEGORY_COUNT)
    .map((row) => ({ name: nameById.get(row.categoryId) ?? "Unknown category", spentAgorot: row.totalAgorot }));

  const corePoints = coreSeries.filter((point) => point.takenAt >= from && point.takenAt < to);

  return {
    monthKey,
    incomeAgorot: month?.incomeAgorot ?? 0n,
    expenseAgorot: month?.expenseAgorot ?? 0n,
    topCategories,
    netWorth:
      snapshots.length >= 2
        ? { startAgorot: snapshots[0].netWorthAgorot, endAgorot: snapshots[snapshots.length - 1].netWorthAgorot }
        : null,
    core:
      corePoints.length >= 2
        ? { startUsdCents: corePoints[0].equityUsdCents, endUsdCents: corePoints[corePoints.length - 1].equityUsdCents }
        : null,
  };
}
