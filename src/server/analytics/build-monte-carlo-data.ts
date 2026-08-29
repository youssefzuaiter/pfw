import "server-only";
import { cache } from "react";
import { agorot, formatAgorot, type Agorot } from "../../lib/money";
import {
  DEFAULT_END_AGE,
  DEFAULT_MONTE_CARLO_ASSUMPTIONS,
  DEFAULT_NUM_SIMULATIONS,
  runMonteCarloSimulation,
  type MonteCarloInput,
  type MonteCarloResult,
} from "../../lib/monte-carlo";
import { getMonthlyIncomeExpenseHistory } from "../dal/transactions";
import { computeLiveNetWorth } from "../dal/net-worth";

/** Trailing window read for the "historical savings rate" default — matches the
 * seed data's own rolling window (AGENTS.md §3a), so a freshly seeded demo
 * account has real months of history to average over. */
const SAVINGS_RATE_LOOKBACK_DAYS = 90;

/** When a user has no assets at all yet (a brand-new account), there's nothing
 * to derive an allocation split from — default to a generic balanced-ish mix
 * rather than divide-by-zero into 0% growth. */
const DEFAULT_GROWTH_ALLOCATION_SHARE = 0.6;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export type MonteCarloAnalyticsData = {
  /** The exact parameters the simulation actually ran with (minus `randomFn`) — the UI echoes
   * these back so a user can see which figures came from their real data vs. their slider choices. */
  input: Omit<MonteCarloInput, "randomFn">;
  result: MonteCarloResult;
  /** DAL-derived figures shown as the widget's starting point, independent of whatever the caller overrode. */
  derived: {
    startingNetWorthAgorot: Agorot;
    growthAllocationShare: number;
    historicalAnnualSavingsAgorot: Agorot;
    historicalAnnualExpenseAgorot: Agorot;
  };
};

/**
 * Assembles everything `/analytics`'s Monte Carlo widget needs: current net
 * worth and asset allocation (live, via `computeLiveNetWorth` — never a
 * stale `NetWorthSnapshot`, per law #5) and a historical savings rate
 * derived from real transaction history, then runs the simulation.
 *
 * `currentAge` has no DAL source — this app never stores a date of birth
 * (AGENTS.md law #6: "Never store: ... national IDs, DOB"), so age is
 * necessarily a per-request input the caller supplies, never persisted
 * anywhere. `retirementAge`/`targetAnnualSpendAgorot`/`volatilityMultiplier`
 * are optional overrides (the widget's three sliders); omitting them falls
 * back to a DAL-derived or conventional default.
 *
 * Wrapped in `cache()` for the same reason `build-dashboard-data.ts` and
 * `build-portfolio-data.ts` are (§3c) — request-scoped, not Next's
 * `'use cache'`, since this is per-user financial data. Arguments are
 * primitives (not an options object) specifically so `cache()`'s
 * per-argument comparison can actually dedupe a call.
 */
export const buildMonteCarloAnalytics = cache(async function buildMonteCarloAnalytics(
  userId: string,
  currentAge: number,
  retirementAgeOverride?: number,
  annualSpendOverrideAgorot?: Agorot,
  volatilityMultiplier = 1,
): Promise<MonteCarloAnalyticsData> {
  const now = new Date();
  const since = new Date(now.getTime() - SAVINGS_RATE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const [netWorth, monthlyHistory] = await Promise.all([
    computeLiveNetWorth(userId, now),
    getMonthlyIncomeExpenseHistory(userId, since, now),
  ]);

  const totalAssets = Number(netWorth.totalAssets);
  const growthAssets = Number(netWorth.breakdown.portfolio) + Number(netWorth.breakdown.manualAssets);
  const growthAllocationShare =
    totalAssets > 0 ? clamp01(growthAssets / totalAssets) : DEFAULT_GROWTH_ALLOCATION_SHARE;

  const totalIncome = monthlyHistory.reduce((sum, m) => sum + m.incomeAgorot, 0n);
  const totalExpense = monthlyHistory.reduce((sum, m) => sum + m.expenseAgorot, 0n);
  const monthsOfData = monthlyHistory.length;

  // Floored at 0: a negative historical net cash flow would violate the
  // engine's "savings must not be negative" input rule, and a shortfall
  // during working years is better represented by raising annualSpend
  // than by a negative "savings" figure the model has no other use for.
  const historicalAnnualSavingsAgorot = agorot(
    monthsOfData > 0 ? Math.max(0, Math.round((Number(totalIncome - totalExpense) / monthsOfData) * 12)) : 0,
  );
  const historicalAnnualExpenseAgorot = agorot(
    monthsOfData > 0 ? Math.max(0, Math.round((Number(totalExpense) / monthsOfData) * 12)) : 0,
  );

  const retirementAge = retirementAgeOverride ?? Math.max(currentAge, 65);
  const annualSpendAgorot = annualSpendOverrideAgorot ?? historicalAnnualExpenseAgorot;

  const input: Omit<MonteCarloInput, "randomFn"> = {
    startingNetWorthAgorot: netWorth.netWorth,
    currentAge,
    retirementAge,
    endAge: DEFAULT_END_AGE,
    annualSavingsAgorot: historicalAnnualSavingsAgorot,
    annualSpendAgorot,
    growthAllocationShare,
    growthReturnMean: DEFAULT_MONTE_CARLO_ASSUMPTIONS.growthReturnMean,
    growthReturnStdDev: DEFAULT_MONTE_CARLO_ASSUMPTIONS.growthReturnStdDev * volatilityMultiplier,
    cashReturnMean: DEFAULT_MONTE_CARLO_ASSUMPTIONS.cashReturnMean,
    cashReturnStdDev: DEFAULT_MONTE_CARLO_ASSUMPTIONS.cashReturnStdDev * volatilityMultiplier,
    inflationMean: DEFAULT_MONTE_CARLO_ASSUMPTIONS.inflationMean,
    inflationStdDev: DEFAULT_MONTE_CARLO_ASSUMPTIONS.inflationStdDev,
    numSimulations: DEFAULT_NUM_SIMULATIONS,
  };

  const result = runMonteCarloSimulation(input);

  return {
    input,
    result,
    derived: {
      startingNetWorthAgorot: netWorth.netWorth,
      growthAllocationShare,
      historicalAnnualSavingsAgorot,
      historicalAnnualExpenseAgorot,
    },
  };
});

function serializeAgorot(value: Agorot) {
  return { agorot: Number(value), formatted: formatAgorot(value) };
}

/**
 * The one place `MonteCarloAnalyticsData` becomes the JSON shape both
 * `GET /api/analytics/monte-carlo` (a client-side re-fetch) and
 * `/analytics/page.tsx` (the first server-rendered paint) send to
 * `MonteCarloWidget` — kept in one place so the two call sites can never
 * drift into two different response shapes for what's supposed to be the
 * same data.
 */
export function serializeMonteCarloAnalytics(analytics: MonteCarloAnalyticsData) {
  return {
    ok: true as const,
    probabilityOfSuccess: analytics.result.probabilityOfSuccess,
    numSimulations: analytics.result.numSimulations,
    yearlyPercentiles: analytics.result.yearlyPercentiles.map((point) => ({
      age: point.age,
      p10: serializeAgorot(point.p10),
      p50: serializeAgorot(point.p50),
      p90: serializeAgorot(point.p90),
    })),
    medianFinalBalance: serializeAgorot(analytics.result.medianFinalBalance),
    worstDecileFinalBalance: serializeAgorot(analytics.result.worstDecileFinalBalance),
    input: {
      currentAge: analytics.input.currentAge,
      retirementAge: analytics.input.retirementAge,
      endAge: analytics.input.endAge,
      annualSavings: serializeAgorot(analytics.input.annualSavingsAgorot),
      annualSpend: serializeAgorot(analytics.input.annualSpendAgorot),
      growthAllocationShare: analytics.input.growthAllocationShare,
    },
    derived: {
      startingNetWorth: serializeAgorot(analytics.derived.startingNetWorthAgorot),
      growthAllocationShare: analytics.derived.growthAllocationShare,
      historicalAnnualSavings: serializeAgorot(analytics.derived.historicalAnnualSavingsAgorot),
      historicalAnnualExpense: serializeAgorot(analytics.derived.historicalAnnualExpenseAgorot),
    },
  };
}

export type MonteCarloAnalyticsResponse = ReturnType<typeof serializeMonteCarloAnalytics>;
