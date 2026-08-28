import { describe, expect, it } from "vitest";
import { agorot } from "../money";
import { generateSpendingSpikeInsights } from "./spending-spikes";

describe("generateSpendingSpikeInsights()", () => {
  it("flags a category whose current spend is a statistical outlier vs. its history", () => {
    const insights = generateSpendingSpikeInsights([
      {
        categoryId: "cat-shopping",
        categoryName: "Shopping",
        currentMonthSpend: agorot(200_000),
        priorMonthsSpend: [agorot(40_000), agorot(42_000), agorot(38_000)],
      },
    ]);
    expect(insights).toHaveLength(1);
    expect(insights[0].type).toBe("spending_spike");
  });

  it("does not flag ordinary month-to-month variation", () => {
    // History already has real spread (stddev ~4,153); 45,000 lands
    // comfortably inside mean + 1.5*stddev (~46,730), not past it.
    const insights = generateSpendingSpikeInsights([
      {
        categoryId: "cat-groceries",
        categoryName: "Groceries",
        currentMonthSpend: agorot(45_000),
        priorMonthsSpend: [agorot(35_000), agorot(45_000), agorot(38_000), agorot(44_000)],
      },
    ]);
    expect(insights).toHaveLength(0);
  });

  it("skips a category with too little history to establish a baseline", () => {
    const insights = generateSpendingSpikeInsights([
      {
        categoryId: "cat-new",
        categoryName: "New Category",
        currentMonthSpend: agorot(500_000),
        priorMonthsSpend: [agorot(1_000)],
      },
    ]);
    expect(insights).toHaveLength(0);
  });

  it("escalates to critical when spend is more than double the average", () => {
    const insights = generateSpendingSpikeInsights([
      {
        categoryId: "cat-entertainment",
        categoryName: "Entertainment",
        currentMonthSpend: agorot(300_000),
        priorMonthsSpend: [agorot(10_000), agorot(11_000), agorot(9_000)],
      },
    ]);
    expect(insights[0].severity).toBe("critical");
  });

  it("does not flag a spend that's below the historical average", () => {
    const insights = generateSpendingSpikeInsights([
      {
        categoryId: "cat-utilities",
        categoryName: "Utilities",
        currentMonthSpend: agorot(10_000),
        priorMonthsSpend: [agorot(40_000), agorot(42_000), agorot(38_000)],
      },
    ]);
    expect(insights).toHaveLength(0);
  });
});
