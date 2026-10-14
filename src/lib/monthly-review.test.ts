import { describe, expect, it } from "vitest";
import { changeFrom, formatBpsChange, spendingShares } from "./monthly-review";

describe("changeFrom", () => {
  it("gives the difference and its percentage of the month before", () => {
    expect(changeFrom(100_000n, 112_500n)).toEqual({ deltaAgorot: 12_500n, bps: 1250 });
    expect(changeFrom(100_000n, 97_000n)).toEqual({ deltaAgorot: -3_000n, bps: -300 });
    expect(changeFrom(50_000n, 50_000n)).toEqual({ deltaAgorot: 0n, bps: 0 });
  });

  it("has no percentage when the month before was zero", () => {
    expect(changeFrom(0n, 40_000n)).toEqual({ deltaAgorot: 40_000n, bps: null });
  });

  it("measures against the size of a negative starting figure, so a smaller loss reads as an improvement", () => {
    expect(changeFrom(-200_000n, -100_000n)).toEqual({ deltaAgorot: 100_000n, bps: 5000 });
  });

  it("rounds half away from zero, the same both ways", () => {
    expect(changeFrom(3n, 4n).bps).toBe(3333); // 3333.33…
    expect(changeFrom(200_000n, 200_001n).bps).toBe(0); // 0.05 bp
    expect(changeFrom(20_000n, 20_001n).bps).toBe(1); // 0.5 bp rounds up
    expect(changeFrom(20_000n, 19_999n).bps).toBe(-1); // -0.5 bp rounds away from zero
    expect(changeFrom(16n, 17n).bps).toBe(625);
    expect(changeFrom(16n, 15n).bps).toBe(-625);
    expect(changeFrom(32n, 33n).bps).toBe(313); // 312.5 rounds up
    expect(changeFrom(32n, 31n).bps).toBe(-313); // -312.5 rounds away from zero
  });
});

describe("formatBpsChange", () => {
  it("prints a signed one-decimal percentage", () => {
    expect(formatBpsChange(1250)).toBe("+12.5%");
    expect(formatBpsChange(-300)).toBe("-3.0%");
    expect(formatBpsChange(0)).toBe("0.0%");
    expect(formatBpsChange(5)).toBe("+0.1%");
  });
});

describe("spendingShares", () => {
  it("orders by amount, largest first, and gives each one's share of the total", () => {
    expect(
      spendingShares([
        { name: "Dining", spentAgorot: 25_000n },
        { name: "Groceries", spentAgorot: 75_000n },
      ]),
    ).toEqual([
      { name: "Groceries", spentAgorot: 75_000n, percent: 75 },
      { name: "Dining", spentAgorot: 25_000n, percent: 25 },
    ]);
  });

  it("breaks a tie by name and never divides by zero", () => {
    expect(spendingShares([{ name: "B", spentAgorot: 1n }, { name: "A", spentAgorot: 1n }]).map((s) => s.name)).toEqual(["A", "B"]);
    expect(spendingShares([{ name: "A", spentAgorot: 0n }])).toEqual([{ name: "A", spentAgorot: 0n, percent: 0 }]);
    expect(spendingShares([])).toEqual([]);
  });

  it("keeps two decimals of a share", () => {
    expect(spendingShares([{ name: "A", spentAgorot: 1n }, { name: "B", spentAgorot: 2n }]).map((s) => s.percent)).toEqual([66.66, 33.33]);
  });
});
