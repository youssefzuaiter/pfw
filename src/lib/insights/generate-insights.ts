import type { CashFlowForecast } from "../cash-flow-forecast";
import type { RecurringDetectionResult } from "../recurring-detection";
import { type BudgetStatus, generateBudgetBreachInsights } from "./budget-breaches";
import { generateCashFlowRiskInsights, type CashFlowRiskThresholds } from "./cash-flow-risk";
import { type GoalPaceInput, generateGoalPaceInsights } from "./goal-pace";
import { type HoldingValue, generatePortfolioConcentrationInsights } from "./portfolio-concentration";
import { generateRecurringChargeInsights } from "./recurring-charges";
import { type CategorySpendHistory, generateSpendingSpikeInsights } from "./spending-spikes";
import { generateTransactionReviewInsights } from "./transaction-review-queue";
import { rankInsights, type Insight } from "./types";

export type GenerateInsightsInput = {
  budgets: readonly BudgetStatus[];
  spendHistories: readonly CategorySpendHistory[];
  cashFlowForecast: CashFlowForecast;
  cashFlowRiskThresholds?: CashFlowRiskThresholds;
  goals: readonly GoalPaceInput[];
  holdings: readonly HoldingValue[];
  recurringResults: readonly RecurringDetectionResult[];
  merchantNameByKey: (merchantKey: string) => string;
  needsReviewCount: number;
};

/**
 * Runs all 7 insight generators (budget breaches, spending spikes,
 * cash-flow risk, goal pace, portfolio concentration, recurring charges,
 * transaction review queue) and returns them ranked by severity + impact,
 * most urgent first — the /dashboard attention feed's data source.
 */
export function generateInsights(input: GenerateInsightsInput): Insight[] {
  const all: Insight[] = [
    ...generateBudgetBreachInsights(input.budgets),
    ...generateSpendingSpikeInsights(input.spendHistories),
    ...generateCashFlowRiskInsights(input.cashFlowForecast, input.cashFlowRiskThresholds),
    ...generateGoalPaceInsights(input.goals),
    ...generatePortfolioConcentrationInsights(input.holdings),
    ...generateRecurringChargeInsights(input.recurringResults, input.merchantNameByKey),
    ...generateTransactionReviewInsights(input.needsReviewCount),
  ];

  return rankInsights(all);
}

export type { Insight, InsightSeverity, InsightType } from "./types";
