import { describe, expect, it } from "vitest";
import { agorot } from "../money";
import { generateBudgetBreachInsights } from "./budget-breaches";

describe("generateBudgetBreachInsights()", () => {
  it("flags a critical breach when the rolling balance is negative", () => {
    const insights = generateBudgetBreachInsights([
      { categoryId: "cat-dining", categoryName: "Dining", balanceAgorot: agorot(-20_000), spentThisMonthAgorot: agorot(50_000) },
    ]);
    expect(insights).toHaveLength(1);
    expect(insights[0]).toMatchObject({ type: "budget_breach", severity: "critical", relatedEntityId: "cat-dining" });
  });

  it("flags a critical breach for a NEGATIVE balance even with ZERO spend this month — a carried-forward deficit, not just fresh overspending", () => {
    const insights = generateBudgetBreachInsights([
      { categoryId: "cat-old-deficit", categoryName: "Old Deficit", balanceAgorot: agorot(-5_000), spentThisMonthAgorot: agorot(0) },
    ]);
    expect(insights).toHaveLength(1);
    expect(insights[0].severity).toBe("critical");
  });

  it("flags a warning when this month's spend has driven the balance to exactly zero", () => {
    const insights = generateBudgetBreachInsights([
      { categoryId: "cat-groceries", categoryName: "Groceries", balanceAgorot: agorot(0), spentThisMonthAgorot: agorot(85_000) },
    ]);
    expect(insights).toHaveLength(1);
    expect(insights[0].severity).toBe("warning");
  });

  it("flags a warning when the balance has dropped below this month's own spend", () => {
    const insights = generateBudgetBreachInsights([
      { categoryId: "cat-groceries", categoryName: "Groceries", balanceAgorot: agorot(10_000), spentThisMonthAgorot: agorot(85_000) },
    ]);
    expect(insights).toHaveLength(1);
    expect(insights[0].severity).toBe("warning");
  });

  it("produces no insight for a healthy positive balance comfortably above this month's spend", () => {
    const insights = generateBudgetBreachInsights([
      { categoryId: "cat-transport", categoryName: "Transport", balanceAgorot: agorot(100_000), spentThisMonthAgorot: agorot(50_000) },
    ]);
    expect(insights).toHaveLength(0);
  });

  it("produces no insight for an inactive envelope (nothing spent this month), even at a low positive balance", () => {
    const insights = generateBudgetBreachInsights([
      { categoryId: "cat-idle", categoryName: "Idle", balanceAgorot: agorot(100), spentThisMonthAgorot: agorot(0) },
    ]);
    expect(insights).toHaveLength(0);
  });

  it("ranks a bigger deficit higher than a smaller one, both critical", () => {
    const insights = generateBudgetBreachInsights([
      { categoryId: "small-deficit", categoryName: "Small", balanceAgorot: agorot(-1_000), spentThisMonthAgorot: agorot(1_000) },
      { categoryId: "big-deficit", categoryName: "Big", balanceAgorot: agorot(-100_000), spentThisMonthAgorot: agorot(100_000) },
    ]);
    const bigDeficit = insights.find((i) => i.relatedEntityId === "big-deficit")!;
    const smallDeficit = insights.find((i) => i.relatedEntityId === "small-deficit")!;
    expect(bigDeficit.rank).toBeGreaterThan(smallDeficit.rank);
  });

  it("a critical breach always outranks a warning, regardless of raw magnitudes", () => {
    const insights = generateBudgetBreachInsights([
      { categoryId: "barely-negative", categoryName: "Barely", balanceAgorot: agorot(-1), spentThisMonthAgorot: agorot(1) },
      { categoryId: "just-warning", categoryName: "Warning", balanceAgorot: agorot(0), spentThisMonthAgorot: agorot(1_000_000) },
    ]);
    const breach = insights.find((i) => i.relatedEntityId === "barely-negative")!;
    const warning = insights.find((i) => i.relatedEntityId === "just-warning")!;
    expect(breach.severity).toBe("critical");
    expect(warning.severity).toBe("warning");
    expect(breach.rank).toBeGreaterThan(warning.rank);
  });
});
