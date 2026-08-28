import { formatAgorot, subtractAgorot, type Agorot } from "../money";
import { computeRank, type Insight } from "./types";

/** Matches the /budgets screen's stated tiers: 80% warning, 100% breach. */
const WARNING_THRESHOLD = 0.8;
const BREACH_THRESHOLD = 1.0;

export type BudgetStatus = {
  categoryId: string;
  categoryName: string;
  monthlyLimit: Agorot;
  /** Positive magnitude — how much has been spent in this category this month so far. */
  spentThisMonth: Agorot;
};

export function generateBudgetBreachInsights(budgets: readonly BudgetStatus[]): Insight[] {
  const insights: Insight[] = [];

  for (const budget of budgets) {
    if (budget.monthlyLimit <= 0) continue;
    const utilization = budget.spentThisMonth / budget.monthlyLimit;

    if (utilization >= BREACH_THRESHOLD) {
      const overspend = subtractAgorot(budget.spentThisMonth, budget.monthlyLimit);
      insights.push({
        type: "budget_breach",
        severity: "critical",
        rank: computeRank("critical", (utilization - 1) * 100),
        title: `${budget.categoryName} budget breached`,
        description: `Spent ${formatAgorot(budget.spentThisMonth)} of a ${formatAgorot(budget.monthlyLimit)} budget — ${formatAgorot(overspend)} over, ${Math.round(utilization * 100)}% used.`,
        relatedEntityId: budget.categoryId,
      });
    } else if (utilization >= WARNING_THRESHOLD) {
      insights.push({
        type: "budget_breach",
        severity: "warning",
        rank: computeRank("warning", ((utilization - WARNING_THRESHOLD) / (BREACH_THRESHOLD - WARNING_THRESHOLD)) * 100),
        title: `${budget.categoryName} budget nearing its limit`,
        description: `Spent ${formatAgorot(budget.spentThisMonth)} of a ${formatAgorot(budget.monthlyLimit)} budget — ${Math.round(utilization * 100)}% used.`,
        relatedEntityId: budget.categoryId,
      });
    }
  }

  return insights;
}
