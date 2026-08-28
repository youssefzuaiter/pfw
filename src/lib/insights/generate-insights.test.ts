import { describe, expect, it } from "vitest";
import { buildCashFlowForecast } from "../cash-flow-forecast";
import { agorot } from "../money";
import { generateInsights } from "./generate-insights";

function emptyForecast() {
  return buildCashFlowForecast({
    startingBalance: agorot(1_000_000),
    startDate: new Date("2026-08-01"),
    recurringItems: [],
    averageDailyDiscretionarySpend: agorot(0),
  });
}

describe("generateInsights() orchestrator", () => {
  it("combines results from multiple generators and ranks them, most urgent first", () => {
    const insights = generateInsights({
      budgets: [
        { categoryId: "cat-dining", categoryName: "Dining", monthlyLimit: agorot(100_000), spentThisMonth: agorot(150_000) },
      ],
      spendHistories: [],
      cashFlowForecast: emptyForecast(),
      goals: [],
      holdings: [],
      recurringResults: [
        {
          merchantKey: "netflix",
          isRecurring: true,
          distinctMonths: 3,
          coefficientOfVariation: 0,
          averageAmount: agorot(4990),
          averageIntervalDays: 30,
        },
      ],
      merchantNameByKey: (key) => key,
      needsReviewCount: 2,
    });

    expect(insights.length).toBeGreaterThanOrEqual(2);
    // Sorted descending by rank.
    for (let i = 1; i < insights.length; i++) {
      expect(insights[i - 1].rank).toBeGreaterThanOrEqual(insights[i].rank);
    }
    // The budget breach (critical) must outrank the recurring-charge info note.
    const breachIndex = insights.findIndex((i) => i.type === "budget_breach");
    const recurringIndex = insights.findIndex((i) => i.type === "recurring_charge_detected");
    expect(breachIndex).toBeLessThan(recurringIndex);
  });

  it("returns an empty array when nothing is noteworthy", () => {
    const insights = generateInsights({
      budgets: [],
      spendHistories: [],
      cashFlowForecast: emptyForecast(),
      goals: [],
      holdings: [],
      recurringResults: [],
      merchantNameByKey: (key) => key,
      needsReviewCount: 0,
    });
    expect(insights).toHaveLength(0);
  });
});
