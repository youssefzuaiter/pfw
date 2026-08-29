import "server-only";
import { cache } from "react";
import { buildCashFlowForecast, estimateAverageDailyDiscretionarySpend } from "../../lib/cash-flow-forecast";
import type { GoalPaceInput } from "../../lib/insights/goal-pace";
import { generateInsights } from "../../lib/insights/generate-insights";
import { agorot, multiplyAgorot, type Agorot } from "../../lib/money";
import { findRecurringMerchants } from "../../lib/recurring-detection";
import { listBudgets } from "../dal/budgets";
import { listCategories } from "../dal/categories";
import { listGoals } from "../dal/goals";
import { getLatestRateTable } from "../dal/exchange-rates";
import { computeLiveNetWorth, getNetWorthHistory } from "../dal/net-worth";
import { listPortfolioHoldings } from "../dal/portfolio";
import {
  countNeedsReview,
  getMonthlyIncomeExpenseHistory,
  getSpendByCategoryInRange,
  getTransactionOccurrencesSince,
} from "../dal/transactions";
import { getMockPriceAgorot } from "../../lib/mock-market-data";

const CASH_FLOW_HISTORY_DAYS = 90;
const SPEND_HISTORY_MONTHS = 6;
const INCOME_EXPENSE_HISTORY_MONTHS = 12;

function startOfMonthUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function monthsBeforeUtc(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - months, 1));
}

function daysBefore(date: Date, days: number): Date {
  return new Date(date.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Fetches and computes everything the /dashboard screen needs in one
 * place: live net worth, its 90-day history, the 60-day cash-flow
 * forecast, and the ranked attention feed (all 7 insight generators).
 * Wrapped in React's `cache()` so a single request that renders several
 * dashboard components sharing this data only computes it once —
 * "request-scoped caching" (Section on the hardened API layer), not
 * Next's cross-request `'use cache'`, which would risk sharing one
 * user's cached financial data with another if a cache key were ever
 * scoped wrong. Nothing here is safe to cache *across* requests.
 */
export const buildDashboardData = cache(async (userId: string, now: Date = new Date()) => {
  const thisMonthStart = startOfMonthUtc(now);
  const nextMonthStart = startOfMonthUtc(monthsBeforeUtc(now, -1));
  const incomeExpenseSince = monthsBeforeUtc(now, INCOME_EXPENSE_HISTORY_MONTHS);
  const occurrencesSince = daysBefore(now, CASH_FLOW_HISTORY_DAYS);

  const spendHistoryWindows = Array.from({ length: SPEND_HISTORY_MONTHS }, (_, i) => ({
    from: monthsBeforeUtc(now, i + 1),
    to: monthsBeforeUtc(now, i),
  }));

  const [
    netWorth,
    netWorthHistory,
    budgets,
    categories,
    goals,
    holdings,
    currentMonthSpend,
    priorMonthsSpend,
    incomeExpenseHistory,
    occurrences,
    needsReviewCount,
    rateTable,
  ] = await Promise.all([
    computeLiveNetWorth(userId, now),
    getNetWorthHistory(userId, CASH_FLOW_HISTORY_DAYS),
    listBudgets(userId),
    listCategories(userId),
    listGoals(userId),
    listPortfolioHoldings(userId),
    getSpendByCategoryInRange(userId, thisMonthStart, nextMonthStart),
    Promise.all(spendHistoryWindows.map((w) => getSpendByCategoryInRange(userId, w.from, w.to))),
    getMonthlyIncomeExpenseHistory(userId, incomeExpenseSince, nextMonthStart),
    getTransactionOccurrencesSince(userId, occurrencesSince),
    countNeedsReview(userId),
    getLatestRateTable(now),
  ]);

  // --- Budget status (this month's spend per budgeted category) ---------
  const spendThisMonthByCategory = new Map(currentMonthSpend.map((s) => [s.categoryId, s.totalAgorot]));
  const budgetStatuses = budgets.map((b) => ({
    categoryId: b.categoryId,
    categoryName: b.category.name,
    monthlyLimit: agorot(Number(b.monthlyLimit)),
    spentThisMonth: agorot(Number(spendThisMonthByCategory.get(b.categoryId) ?? 0n)),
  }));

  // --- Spending-spike history (6 prior months, zero-filled) -------------
  const spendHistoryByCategory = new Map<string, number[]>();
  for (const monthRows of priorMonthsSpend) {
    const byCategory = new Map(monthRows.map((r) => [r.categoryId, Number(r.totalAgorot)]));
    for (const category of categories) {
      const arr = spendHistoryByCategory.get(category.id) ?? [];
      arr.push(byCategory.get(category.id) ?? 0);
      spendHistoryByCategory.set(category.id, arr);
    }
  }
  const spendHistories = categories
    .filter((c) => !c.isUncategorized)
    .map((c) => ({
      categoryId: c.id,
      categoryName: c.name,
      currentMonthSpend: agorot(Number(spendThisMonthByCategory.get(c.id) ?? 0n)),
      priorMonthsSpend: (spendHistoryByCategory.get(c.id) ?? []).map((v) => agorot(v)),
    }));

  // --- Category donut data (this month, expense categories only) -------
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const categorySpendBreakdown = currentMonthSpend
    .map((s) => ({
      categoryId: s.categoryId,
      categoryName: categoryById.get(s.categoryId)?.name ?? "Unknown",
      amount: agorot(Number(s.totalAgorot)),
    }))
    .filter((s) => s.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  // --- Recurring detection + cash-flow forecast --------------------------
  const recurringResults = findRecurringMerchants(
    occurrences.map((o) => ({ merchantKey: o.merchantKey, amount: agorot(Number(o.amount)), occurredAt: o.occurredAt })),
  );

  const lastOccurrenceByMerchant = new Map<string, Date>();
  for (const o of occurrences) {
    const existing = lastOccurrenceByMerchant.get(o.merchantKey);
    if (!existing || o.occurredAt > existing) lastOccurrenceByMerchant.set(o.merchantKey, o.occurredAt);
  }

  const recurringProjections = recurringResults
    .filter((r) => r.isRecurring && r.averageIntervalDays !== null)
    .map((r) => ({
      merchantKey: r.merchantKey,
      amount: r.averageAmount,
      averageIntervalDays: r.averageIntervalDays as number,
      lastOccurredAt: lastOccurrenceByMerchant.get(r.merchantKey) ?? now,
    }));

  const recurringMerchantKeys = new Set(recurringProjections.map((p) => p.merchantKey));
  const discretionaryAmounts: Agorot[] = occurrences
    .filter((o) => o.amount < 0n && !recurringMerchantKeys.has(o.merchantKey))
    .map((o) => agorot(Number(o.amount)));
  const averageDailyDiscretionarySpend =
    discretionaryAmounts.length > 0
      ? estimateAverageDailyDiscretionarySpend(discretionaryAmounts, CASH_FLOW_HISTORY_DAYS)
      : agorot(0);

  const cashFlowForecast = buildCashFlowForecast({
    startingBalance: netWorth.breakdown.bankAccounts,
    startDate: now,
    recurringItems: recurringProjections,
    averageDailyDiscretionarySpend,
  });

  // --- Goal pace ------------------------------------------------------------
  const goalPaceInputs: GoalPaceInput[] = goals.map((g) => ({
    goalId: g.id,
    goalName: g.name,
    targetAmount: agorot(Number(g.targetAmount)),
    currentAmount: agorot(g.contributions.reduce((sum, c) => sum + Number(c.amount), 0)),
    startDate: g.createdAt,
    targetDate: g.targetDate ?? undefined,
    today: now,
  }));

  // --- Portfolio concentration -----------------------------------------
  const portfolioHoldingValues = holdings.map((h) => ({
    symbol: h.symbol,
    currentValue: multiplyAgorot(getMockPriceAgorot(h.symbol, now, rateTable.USD), h.quantity.toNumber()),
  }));

  const merchantNameByKey = (key: string) => occurrences.find((o) => o.merchantKey === key)?.displayName ?? key;

  const insights = generateInsights({
    budgets: budgetStatuses,
    spendHistories,
    cashFlowForecast,
    goals: goalPaceInputs,
    holdings: portfolioHoldingValues,
    recurringResults,
    merchantNameByKey,
    needsReviewCount,
  });

  return {
    netWorth,
    netWorthHistory: netWorthHistory.map((snap) => ({
      date: snap.snapshotDate,
      netWorth: agorot(Number(snap.netWorthAgorot)),
    })),
    cashFlowForecast,
    categorySpendBreakdown,
    incomeExpenseHistory: incomeExpenseHistory.map((m) => ({
      monthKey: m.monthKey,
      income: agorot(Number(m.incomeAgorot)),
      expense: agorot(Number(m.expenseAgorot)),
    })),
    insights,
    needsReviewCount,
  };
});

export type DashboardData = Awaited<ReturnType<typeof buildDashboardData>>;
