import { describe, expect, it } from "vitest";
import { agorot } from "../money";
import { generateBudgetBreachInsights } from "./budget-breaches";

describe("generateBudgetBreachInsights()", () => {
  it("flags a breach at or above 100% utilization", () => {
    const insights = generateBudgetBreachInsights([
      { categoryId: "cat-dining", categoryName: "Dining", monthlyLimit: agorot(100_000), spentThisMonth: agorot(120_000) },
    ]);
    expect(insights).toHaveLength(1);
    expect(insights[0]).toMatchObject({ type: "budget_breach", severity: "critical", relatedEntityId: "cat-dining" });
  });

  it("flags a warning between 80% and 100% utilization", () => {
    const insights = generateBudgetBreachInsights([
      { categoryId: "cat-groceries", categoryName: "Groceries", monthlyLimit: agorot(100_000), spentThisMonth: agorot(85_000) },
    ]);
    expect(insights).toHaveLength(1);
    expect(insights[0].severity).toBe("warning");
  });

  it("produces no insight below the 80% warning threshold", () => {
    const insights = generateBudgetBreachInsights([
      { categoryId: "cat-transport", categoryName: "Transport", monthlyLimit: agorot(100_000), spentThisMonth: agorot(50_000) },
    ]);
    expect(insights).toHaveLength(0);
  });

  it("ranks a bigger overspend higher than a smaller one, both critical", () => {
    const insights = generateBudgetBreachInsights([
      { categoryId: "small-over", categoryName: "Small", monthlyLimit: agorot(100_000), spentThisMonth: agorot(101_000) },
      { categoryId: "big-over", categoryName: "Big", monthlyLimit: agorot(100_000), spentThisMonth: agorot(200_000) },
    ]);
    const bigOver = insights.find((i) => i.relatedEntityId === "big-over")!;
    const smallOver = insights.find((i) => i.relatedEntityId === "small-over")!;
    expect(bigOver.rank).toBeGreaterThan(smallOver.rank);
  });

  it("a critical breach always outranks a warning, regardless of raw percentages", () => {
    const insights = generateBudgetBreachInsights([
      { categoryId: "barely-breached", categoryName: "Barely", monthlyLimit: agorot(100_000), spentThisMonth: agorot(100_001) },
      { categoryId: "almost-breached", categoryName: "Almost", monthlyLimit: agorot(100_000), spentThisMonth: agorot(99_999) },
    ]);
    const breach = insights.find((i) => i.relatedEntityId === "barely-breached")!;
    const warning = insights.find((i) => i.relatedEntityId === "almost-breached")!;
    expect(breach.severity).toBe("critical");
    expect(warning.severity).toBe("warning");
    expect(breach.rank).toBeGreaterThan(warning.rank);
  });

  it("ignores a zero-limit budget rather than dividing by zero", () => {
    const insights = generateBudgetBreachInsights([
      { categoryId: "zero", categoryName: "Zero", monthlyLimit: agorot(0), spentThisMonth: agorot(500) },
    ]);
    expect(insights).toHaveLength(0);
  });
});
