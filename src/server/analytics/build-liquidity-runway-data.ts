import "server-only";
import { cache } from "react";
import { agorot } from "../../lib/money";
import { calculateMonthlyBurnRate, type BurnRateResult, type MonthlyExpense } from "../../lib/burn-rate";
import { calculateLiquidityRunway, type LiquidityRunwayResult } from "../../lib/liquidity-runway";
import type { LiquidityBreakdown } from "../../lib/liquidity-classification";
import { computeLiveNetWorth } from "../dal/net-worth";
import { getMonthlyIncomeExpenseHistory } from "../dal/transactions";
import { buildSubscriptionRadarData } from "../subscriptions/build-subscription-radar-data";

/** How many trailing months of transaction history feed the burn-rate average — matches `calculateMonthlyBurnRate`'s own default, named explicitly here rather than left implicit, since this is also how far back `getMonthlyIncomeExpenseHistory` is asked to look. */
const BURN_RATE_TRAILING_MONTHS = 3;

export type LiquidityRunwayData = {
  runway: LiquidityRunwayResult;
  burnRate: BurnRateResult;
  /** The liquid-vs-semi-liquid split behind `runway.availableAgorot` — kept separate so the UI can show both figures, not just their sum. */
  breakdown: LiquidityBreakdown;
};

/**
 * Assembles everything the dashboard's runway card needs (AGENTS.md
 * §3v): the live liquidity breakdown (via `computeLiveNetWorth`, which
 * now also classifies assets — see that function's own doc comment for
 * why this costs no extra query), a monthly burn rate derived from
 * trailing transaction history, and the subscription radar's cash-drag
 * total as the burn rate's floor (`buildSubscriptionRadarData` is itself
 * `cache()`-wrapped, so calling it here and from `/transactions/subscriptions`
 * in the same request shares one computation, not two).
 *
 * `cache()`-wrapped for the same per-request-scoping reason every other
 * `build-*-data.ts` aggregator is (§3c) — per-user financial data, never
 * a cross-request cache.
 */
export const buildLiquidityRunwayData = cache(async function buildLiquidityRunwayData(
  userId: string,
  asOf: Date = new Date(),
): Promise<LiquidityRunwayData> {
  const since = new Date(asOf.getTime());
  since.setUTCMonth(since.getUTCMonth() - BURN_RATE_TRAILING_MONTHS);

  const [netWorth, monthlyHistory, subscriptionRadar] = await Promise.all([
    computeLiveNetWorth(userId, asOf),
    getMonthlyIncomeExpenseHistory(userId, since, asOf),
    buildSubscriptionRadarData(userId, asOf),
  ]);

  const monthlyExpenses: MonthlyExpense[] = monthlyHistory.map((m) => ({
    monthKey: m.monthKey,
    expenseAgorot: agorot(Number(m.expenseAgorot)),
  }));

  const burnRate = calculateMonthlyBurnRate(monthlyExpenses, subscriptionRadar.cashDragMonthlyAgorot, {
    trailingMonths: BURN_RATE_TRAILING_MONTHS,
  });

  const runway = calculateLiquidityRunway(netWorth.liquidity, burnRate.monthlyBurnRateAgorot);

  return { runway, burnRate, breakdown: netWorth.liquidity };
});
