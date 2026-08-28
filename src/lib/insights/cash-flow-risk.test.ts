import { describe, expect, it } from "vitest";
import { buildCashFlowForecast } from "../cash-flow-forecast";
import { agorot } from "../money";
import { generateCashFlowRiskInsights } from "./cash-flow-risk";

function forecastWithMinimum(balance: number): ReturnType<typeof buildCashFlowForecast> {
  return buildCashFlowForecast({
    startingBalance: agorot(balance),
    startDate: new Date("2026-08-01"),
    horizonDays: 5,
    recurringItems: [],
    averageDailyDiscretionarySpend: agorot(0),
  });
}

describe("generateCashFlowRiskInsights()", () => {
  it("flags critical when the projected minimum goes to zero or below", () => {
    const insights = generateCashFlowRiskInsights(forecastWithMinimum(0));
    expect(insights).toHaveLength(1);
    expect(insights[0].severity).toBe("critical");
  });

  it("flags warning when the minimum is positive but thin", () => {
    const insights = generateCashFlowRiskInsights(forecastWithMinimum(20_000));
    expect(insights).toHaveLength(1);
    expect(insights[0].severity).toBe("warning");
  });

  it("produces no insight when the minimum stays comfortably positive", () => {
    const insights = generateCashFlowRiskInsights(forecastWithMinimum(1_000_000));
    expect(insights).toHaveLength(0);
  });

  it("respects custom thresholds", () => {
    const insights = generateCashFlowRiskInsights(forecastWithMinimum(500_000), {
      criticalBelow: agorot(0),
      warningBelow: agorot(1_000_000),
    });
    expect(insights[0].severity).toBe("warning");
  });
});
