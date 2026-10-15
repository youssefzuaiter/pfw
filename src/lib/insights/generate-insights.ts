import type { CashFlowForecast } from "../cash-flow-forecast";
import type { RecurringDetectionResult } from "../recurring-detection";
import { type EnvelopeStatus, generateBudgetBreachInsights } from "./budget-breaches";
import { generateCashFlowRiskInsights, type CashFlowRiskThresholds } from "./cash-flow-risk";
import { type GoalPaceInput, generateGoalPaceInsights } from "./goal-pace";
import { type HoldingValue, generatePortfolioConcentrationInsights } from "./portfolio-concentration";
import { generateRecurringChargeInsights } from "./recurring-charges";
import { type CategorySpendHistory, type MinorUnitsFormatter, generateSpendingSpikeInsights } from "./spending-spikes";
import { generateTransactionReviewInsights } from "./transaction-review-queue";
import { formatAgorot } from "../money";
import { rankInsights, type Insight, type MoneyFormatter } from "./types";

export type GenerateInsightsInput = {
  envelopes: readonly EnvelopeStatus[];
  spendHistories: readonly CategorySpendHistory[];
  cashFlowForecast: CashFlowForecast;
  cashFlowRiskThresholds?: CashFlowRiskThresholds;
  goals: readonly GoalPaceInput[];
  holdings: readonly HoldingValue[];
  recurringResults: readonly RecurringDetectionResult[];
  merchantNameByKey: (merchantKey: string) => string;
  needsReviewCount: number;
  /** Defaults to `formatAgorot`; the dashboard passes the reporting-currency formatter (AGENTS.md §3nnn). */
  formatMoney?: MoneyFormatter;
  /** Formats a figure already in the reporting currency (the spike text's per-transaction totals, AGENTS.md §3vvv). */
  formatMinor?: MinorUnitsFormatter;
};

/**
 * Runs all 7 insight generators (budget breaches, spending spikes,
 * cash-flow risk, goal pace, portfolio concentration, recurring charges,
 * transaction review queue) and returns them ranked by severity + impact,
 * most urgent first — the /dashboard attention feed's data source.
 */
export function generateInsights(input: GenerateInsightsInput): Insight[] {
  const formatMoney = input.formatMoney ?? formatAgorot;
  const all: Insight[] = [
    ...generateBudgetBreachInsights(input.envelopes, formatMoney),
    ...generateSpendingSpikeInsights(input.spendHistories, formatMoney, input.formatMinor),
    ...generateCashFlowRiskInsights(input.cashFlowForecast, input.cashFlowRiskThresholds, formatMoney),
    ...generateGoalPaceInsights(input.goals, formatMoney),
    ...generatePortfolioConcentrationInsights(input.holdings),
    ...generateRecurringChargeInsights(input.recurringResults, input.merchantNameByKey, formatMoney),
    ...generateTransactionReviewInsights(input.needsReviewCount),
  ];

  return rankInsights(all);
}

export type { Insight, InsightSeverity, InsightType } from "./types";
