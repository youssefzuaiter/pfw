import { describe, expect, it } from "vitest";
import { computeAvailableToBudget, computeRollingBalance, type MonthlyEnvelopeActivity } from "./envelope-math";
import { agorot } from "./money";

function activity(month: string, allocated: number, spent: number): MonthlyEnvelopeActivity {
  return { month, allocatedAgorot: agorot(allocated), spentAgorot: agorot(spent) };
}

describe("computeRollingBalance()", () => {
  it("a single month with no spend: balance equals the allocation", () => {
    const balance = computeRollingBalance([activity("2026-01", 10_000, 0)], "2026-01");
    expect(balance).toBe(10_000);
  });

  it("a single month fully spent: balance is zero", () => {
    const balance = computeRollingBalance([activity("2026-01", 10_000, 10_000)], "2026-01");
    expect(balance).toBe(0);
  });

  it("CARRIES FORWARD unspent funds into the next month", () => {
    const history = [
      activity("2026-01", 10_000, 4_000), // 6,000 left over
      activity("2026-02", 5_000, 3_000), // this month's own delta is +2,000
    ];
    // Rolling balance at Feb = (10,000 + 5,000) - (4,000 + 3,000) = 8,000,
    // i.e. January's 6,000 leftover carried forward plus February's own
    // 2,000 net — never reset to just February's own numbers.
    expect(computeRollingBalance(history, "2026-02")).toBe(8_000);
  });

  it("carries forward across THREE consecutive months of pure surplus", () => {
    const history = [activity("2026-01", 1_000, 0), activity("2026-02", 1_000, 0), activity("2026-03", 1_000, 0)];
    expect(computeRollingBalance(history, "2026-01")).toBe(1_000);
    expect(computeRollingBalance(history, "2026-02")).toBe(2_000);
    expect(computeRollingBalance(history, "2026-03")).toBe(3_000);
  });

  it("DEDUCTS OVERSPENDING — a month that spent more than it was allocated produces a negative delta", () => {
    const history = [activity("2026-01", 5_000, 8_000)]; // overspent by 3,000
    expect(computeRollingBalance(history, "2026-01")).toBe(-3_000);
  });

  it("an overspent month's deficit carries into the NEXT month's balance too, unless offset", () => {
    const history = [
      activity("2026-01", 5_000, 8_000), // -3,000
      activity("2026-02", 5_000, 0), // +5,000
    ];
    // The February allocation has to cover January's own deficit before
    // the envelope reads positive again: -3,000 + 5,000 = 2,000.
    expect(computeRollingBalance(history, "2026-02")).toBe(2_000);
  });

  it("an overspent month's deficit is NOT auto-covered if the next month's own allocation is too small", () => {
    const history = [
      activity("2026-01", 5_000, 8_000), // -3,000
      activity("2026-02", 1_000, 0), // +1,000, not enough to cover the prior deficit
    ];
    expect(computeRollingBalance(history, "2026-02")).toBe(-2_000);
  });

  it("only sums months up to and including the target month — a later month's activity is never included", () => {
    const history = [activity("2026-01", 1_000, 0), activity("2026-06", 999_999, 999_999)];
    expect(computeRollingBalance(history, "2026-01")).toBe(1_000);
  });

  it("a target month with no activity at all yet still reflects prior months' carry-forward", () => {
    const history = [activity("2026-01", 1_000, 200)];
    // Asking for the balance as of March, with nothing allocated/spent in
    // February or March, should still show January's 800 leftover.
    expect(computeRollingBalance(history, "2026-03")).toBe(800);
  });

  it("handles a year boundary correctly", () => {
    const history = [activity("2025-12", 1_000, 0), activity("2026-01", 500, 0)];
    expect(computeRollingBalance(history, "2026-01")).toBe(1_500);
  });

  it("returns zero for no activity at all", () => {
    expect(computeRollingBalance([], "2026-01")).toBe(0);
  });
});

describe("computeAvailableToBudget()", () => {
  it("is income minus total allocated", () => {
    expect(computeAvailableToBudget(agorot(50_000), agorot(30_000))).toBe(20_000);
  });

  it("can go negative — allocating more than real income received so far", () => {
    expect(computeAvailableToBudget(agorot(10_000), agorot(15_000))).toBe(-5_000);
  });

  it("is zero when nothing has been allocated yet", () => {
    expect(computeAvailableToBudget(agorot(10_000), agorot(0))).toBe(10_000);
  });
});
