import { describe, expect, it } from "vitest";
import {
  allocationFits,
  computeAvailableToBudget,
  computeRollingBalance,
  reserveIncrease,
  sumEnvelopeReserve,
  type MonthlyEnvelopeActivity,
} from "./envelope-math";
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

  it("does not count spending from before the envelope existed as a deficit", () => {
    // Six months of spending with no budget, then a first allocation in March.
    const history = [
      activity("2025-09", 0, 9_000),
      activity("2025-10", 0, 9_000),
      activity("2026-01", 0, 9_000),
      activity("2026-03", 5_000, 1_000),
    ];
    // Only March onwards is drawn from the envelope: 5,000 - 1,000, not 5,000 - 28,000.
    expect(computeRollingBalance(history, "2026-03")).toBe(4_000);
  });

  it("starts from the FIRST allocation month, and spending in that month counts", () => {
    const history = [activity("2026-01", 0, 700), activity("2026-02", 3_000, 1_200)];
    expect(computeRollingBalance(history, "2026-02")).toBe(1_800);
  });

  it("an envelope that has never been allocated to has no balance, however much was spent", () => {
    expect(computeRollingBalance([activity("2026-01", 0, 50_000)], "2026-01")).toBe(0);
  });

  it("an allocation in a month AFTER the target does not start the envelope early", () => {
    const history = [activity("2026-01", 0, 4_000), activity("2026-06", 10_000, 0)];
    expect(computeRollingBalance(history, "2026-02")).toBe(0);
    expect(computeRollingBalance(history, "2026-06")).toBe(10_000);
  });

  it("still carries a real deficit forward once the envelope exists", () => {
    const history = [activity("2026-01", 0, 9_000), activity("2026-02", 2_000, 5_000), activity("2026-03", 0, 1_000)];
    expect(computeRollingBalance(history, "2026-03")).toBe(-4_000);
  });
});

describe("computeAvailableToBudget()", () => {
  it("is cash, less what cards owe, less what is already in envelopes", () => {
    expect(computeAvailableToBudget({ cashAgorot: agorot(72_100), cardOwedAgorot: agorot(10_000), envelopeReserveAgorot: agorot(20_000) })).toBe(42_100);
  });

  it("can go negative when more is set aside than the cash covers", () => {
    expect(computeAvailableToBudget({ cashAgorot: agorot(10_000), cardOwedAgorot: agorot(0), envelopeReserveAgorot: agorot(15_000) })).toBe(-5_000);
  });

  it("is all the cash when nothing is owed or set aside", () => {
    expect(computeAvailableToBudget({ cashAgorot: agorot(10_000), cardOwedAgorot: agorot(0), envelopeReserveAgorot: agorot(0) })).toBe(10_000);
  });
});

describe("sumEnvelopeReserve()", () => {
  it("counts positive balances only; an overdrawn envelope adds nothing back", () => {
    expect(sumEnvelopeReserve([5_000, -3_000, 2_000, 0])).toBe(7_000);
  });

  it("is zero for no envelopes", () => {
    expect(sumEnvelopeReserve([])).toBe(0);
  });
});

describe("reserveIncrease()", () => {
  it("is the whole change for an envelope in credit", () => {
    expect(reserveIncrease(5_000, 2_000)).toBe(2_000);
    expect(reserveIncrease(5_000, -2_000)).toBe(-2_000);
  });

  it("does not count covering an overspend: the money already left", () => {
    expect(reserveIncrease(-10_000, 10_000)).toBe(0);
    expect(reserveIncrease(-10_000, 4_000)).toBe(0);
  });

  it("counts only the part above zero once an overspend is covered", () => {
    expect(reserveIncrease(-10_000, 25_000)).toBe(15_000);
  });

  it("never sets aside more than what a reduction frees", () => {
    expect(reserveIncrease(1_000, -5_000)).toBe(-1_000);
  });
});

describe("allocationFits()", () => {
  it("allows setting aside no more than the available cash", () => {
    expect(allocationFits(5_000, 5_000)).toBe(true);
    expect(allocationFits(5_001, 5_000)).toBe(false);
  });

  it("always allows a reduction or no change, even with nothing available", () => {
    expect(allocationFits(-1_000, -5_000)).toBe(true);
    expect(allocationFits(0, -5_000)).toBe(true);
  });

  it("refuses any increase when more is already set aside than the cash covers", () => {
    expect(allocationFits(1, -5_000)).toBe(false);
  });
});
