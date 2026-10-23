import { monthKeyToStartDate, shiftMonthKey } from "./date-month";
import { utcDayKey } from "./fx-history";
import { flowInReporting, type ReportingContext, type ReportingFlow } from "./reporting-currency";

/**
 * Where spending is rising or falling (AGENTS.md §3iiii), per category. Pure:
 * the caller supplies the flows already fetched.
 *
 * The comparison is fair by construction. Early in a month, "this month so
 * far" against a whole earlier month would always look like a collapse, so it
 * is compared with the same days of the earlier months: the 1st to the 12th,
 * if today is the 12th. The usual figure is the average of the months before,
 * over those same days.
 *
 * All amounts are positive magnitudes of spending in the reporting
 * currency's minor units, each transaction converted on its own day and then
 * added (AGENTS.md §3vvv), so a month equals the sum of its categories.
 */

export type TrendFlow = ReportingFlow & { categoryId: string };

/** How many months before this one make up "your usual". */
export const BASELINE_MONTHS = 3;
/** The months shown: this one and the five before it. */
export const TREND_WINDOW_MONTHS = 6;

export type MonthSpend = {
  monthKey: string;
  /** The whole month's spending (so far, for the current month). */
  spend: number;
  /** Only the days up to the same day of the month as today. */
  spendSameDays: number;
};

export type CategoryTrend = {
  categoryId: string;
  /** This month, so far. */
  thisMonth: number;
  /** The average of the earlier months over the same days; 0 when there is no earlier data. */
  usualByNow: number;
  /** thisMonth − usualByNow. */
  difference: number;
  /** The difference as basis points of the usual figure; null when the usual figure is 0 (a change from nothing has no percentage). */
  differenceBps: number | null;
  /** Last month, the whole month. */
  lastMonth: number;
};

export type SpendingTrends = {
  /** This month's key, and the day of the month the comparison runs to. */
  monthKey: string;
  dayOfMonth: number;
  /** Oldest first, the current month last. */
  months: MonthSpend[];
  /** How many earlier months had any spending and so went into "usual". */
  baselineMonthsUsed: number;
  thisMonth: number;
  usualByNow: number;
  difference: number;
  differenceBps: number | null;
  /** Every category with spending in the window, biggest first by the larger of this month and usual. */
  categories: CategoryTrend[];
  /** The largest rises and falls against usual, for the plain-language summary. */
  biggestRises: CategoryTrend[];
  biggestFalls: CategoryTrend[];
};

function daysInMonth(monthKey: string): number {
  const start = monthKeyToStartDate(monthKey);
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
}

function bpsOf(base: number, difference: number): number | null {
  if (base === 0) return null;
  // Half away from zero, in integers.
  const scaled = difference * 10_000;
  const half = Math.floor(Math.abs(base) / 2);
  return scaled >= 0 ? Math.floor((scaled + half) / Math.abs(base)) : -Math.floor((-scaled + half) / Math.abs(base));
}

function averageRounded(total: number, count: number): number {
  return count === 0 ? 0 : Math.round(total / count);
}

export function buildSpendingTrends(input: {
  flows: Iterable<TrendFlow>;
  context: ReportingContext;
  asOf: Date;
  /** How many items each of the rises and falls lists keeps. */
  highlightCount?: number;
}): SpendingTrends {
  const { context, asOf, highlightCount = 3 } = input;
  const monthKey = utcDayKey(asOf).slice(0, 7);
  const dayOfMonth = asOf.getUTCDate();
  const monthKeys = Array.from({ length: TREND_WINDOW_MONTHS }, (_, index) => shiftMonthKey(monthKey, index - (TREND_WINDOW_MONTHS - 1)));
  const inWindow = new Set(monthKeys);

  // Per category, per month: the whole month and the same days.
  const whole = new Map<string, Map<string, number>>();
  const sameDays = new Map<string, Map<string, number>>();
  const bump = (map: Map<string, Map<string, number>>, categoryId: string, month: string, value: number) => {
    const byMonth = map.get(categoryId) ?? new Map<string, number>();
    byMonth.set(month, (byMonth.get(month) ?? 0) + value);
    map.set(categoryId, byMonth);
  };

  for (const flow of input.flows) {
    if (Number(flow.amount) >= 0) continue; // income is not spending
    const dayKey = utcDayKey(flow.occurredAt);
    const month = dayKey.slice(0, 7);
    if (!inWindow.has(month)) continue;
    const magnitude = -flowInReporting(flow, context);
    bump(whole, flow.categoryId, month, magnitude);
    // The same days: up to today's day of the month, or the whole of a shorter month.
    if (Number(dayKey.slice(8, 10)) <= Math.min(dayOfMonth, daysInMonth(month))) bump(sameDays, flow.categoryId, month, magnitude);
  }

  const sum = (map: Map<string, Map<string, number>>, month: string) => {
    let total = 0;
    for (const byMonth of map.values()) total += byMonth.get(month) ?? 0;
    return total;
  };

  const months: MonthSpend[] = monthKeys.map((key) => ({ monthKey: key, spend: sum(whole, key), spendSameDays: sum(sameDays, key) }));

  const baselineKeys = monthKeys.slice(-1 - BASELINE_MONTHS, -1);
  const baselineKeysWithSpend = baselineKeys.filter((key) => (months.find((m) => m.monthKey === key)?.spend ?? 0) > 0);
  const baselineMonthsUsed = baselineKeysWithSpend.length;
  const lastMonthKey = monthKeys[monthKeys.length - 2];

  const categoryIds = new Set<string>([...whole.keys()]);
  const categories: CategoryTrend[] = [...categoryIds].map((categoryId) => {
    const thisMonth = sameDays.get(categoryId)?.get(monthKey) ?? 0;
    const usualTotal = baselineKeysWithSpend.reduce((total, key) => total + (sameDays.get(categoryId)?.get(key) ?? 0), 0);
    const usualByNow = averageRounded(usualTotal, baselineMonthsUsed);
    const difference = thisMonth - usualByNow;
    return {
      categoryId,
      thisMonth,
      usualByNow,
      difference,
      differenceBps: bpsOf(usualByNow, difference),
      lastMonth: whole.get(categoryId)?.get(lastMonthKey) ?? 0,
    };
  });
  // A category that only spent in an earlier month is still part of the picture (it is the fall).
  categories.sort((a, b) => Math.max(b.thisMonth, b.usualByNow) - Math.max(a.thisMonth, a.usualByNow) || a.categoryId.localeCompare(b.categoryId));

  const thisMonth = months[months.length - 1].spendSameDays;
  const usualTotal = baselineKeysWithSpend.reduce((total, key) => total + (months.find((m) => m.monthKey === key)?.spendSameDays ?? 0), 0);
  const usualByNow = averageRounded(usualTotal, baselineMonthsUsed);

  const byDifference = [...categories].filter((category) => category.difference !== 0);
  return {
    monthKey,
    dayOfMonth,
    months,
    baselineMonthsUsed,
    thisMonth,
    usualByNow,
    difference: thisMonth - usualByNow,
    differenceBps: bpsOf(usualByNow, thisMonth - usualByNow),
    categories,
    biggestRises: byDifference.filter((c) => c.difference > 0).sort((a, b) => b.difference - a.difference).slice(0, highlightCount),
    biggestFalls: byDifference.filter((c) => c.difference < 0).sort((a, b) => a.difference - b.difference).slice(0, highlightCount),
  };
}
