import { describe, expect, it } from "vitest";
import { agorot } from "./money";
import type { LiquidityBreakdown } from "./liquidity-classification";
import { AVERAGE_DAYS_PER_MONTH, calculateLiquidityRunway } from "./liquidity-runway";

function breakdown(liquid: number, semiLiquid: number, illiquid = 0): LiquidityBreakdown {
  return { liquidAgorot: agorot(liquid), semiLiquidAgorot: agorot(semiLiquid), illiquidAgorot: agorot(illiquid) };
}

describe("calculateLiquidityRunway", () => {
  it("computes day-precise runway for a normal case, not rounded to whole days", () => {
    // Available = 100,000 agorot (₪1,000). Monthly burn = 50,000 agorot (₪500).
    // Daily burn = 50,000 / (365.25/12) ≈ 1642.71. Runway ≈ 60.88 days.
    const result = calculateLiquidityRunway(breakdown(60_000, 40_000), agorot(50_000));
    expect(result.availableAgorot).toBe(100_000);
    expect(result.dailyBurnRateAgorot).toBeCloseTo(50_000 / AVERAGE_DAYS_PER_MONTH, 6);
    expect(result.runwayDays).not.toBeNull();
    expect(result.runwayDays).toBeCloseTo(100_000 / (50_000 / AVERAGE_DAYS_PER_MONTH), 6);
    // Sanity-check it's genuinely fractional, not an integer month count.
    expect(Number.isInteger(result.runwayDays)).toBe(false);
  });

  it("illiquid assets are excluded from the available total entirely", () => {
    const result = calculateLiquidityRunway(breakdown(10_000, 0, 10_000_000_000), agorot(1_000));
    expect(result.availableAgorot).toBe(10_000); // the illiquid 10 billion agorot must not appear here
  });

  it("liquid and semi-liquid assets are summed together as one 'available' pool", () => {
    const result = calculateLiquidityRunway(breakdown(30_000, 70_000), agorot(1_000));
    expect(result.availableAgorot).toBe(100_000);
  });

  it("zero monthly burn rate means infinite runway, represented as null (not Infinity, not a huge number)", () => {
    const result = calculateLiquidityRunway(breakdown(500_000, 0), agorot(0));
    expect(result.runwayDays).toBeNull();
  });

  it("a hypothetically negative monthly burn rate (net saving) is also treated as infinite runway", () => {
    const result = calculateLiquidityRunway(breakdown(500_000, 0), agorot(-1000));
    expect(result.runwayDays).toBeNull();
  });

  it("zero available assets with a positive burn rate reports exactly 0 days, not null or negative", () => {
    const result = calculateLiquidityRunway(breakdown(0, 0), agorot(50_000));
    expect(result.runwayDays).toBe(0);
  });

  it("a hypothetically negative available total (defensive — should not occur given how this app's balances are modeled) clamps to 0 days, never a negative number", () => {
    const result = calculateLiquidityRunway(breakdown(-5_000, 0), agorot(50_000));
    expect(result.availableAgorot).toBe(-5_000);
    expect(result.runwayDays).toBe(0);
  });

  it("a very large available total against a tiny burn rate produces a large but finite, correctly-computed number", () => {
    const result = calculateLiquidityRunway(breakdown(100_000_000_000, 0), agorot(1));
    expect(result.runwayDays).not.toBeNull();
    expect(Number.isFinite(result.runwayDays)).toBe(true);
    expect(result.runwayDays).toBeCloseTo(100_000_000_000 / (1 / AVERAGE_DAYS_PER_MONTH), 2);
  });

  it("a tiny available total against a large burn rate produces a small, correctly-computed fractional-day result", () => {
    const result = calculateLiquidityRunway(breakdown(100, 0), agorot(10_000_000));
    expect(result.runwayDays).not.toBeNull();
    expect(result.runwayDays).toBeGreaterThan(0);
    expect(result.runwayDays).toBeLessThan(1); // less than a single day of runway
  });

  it("exactly one average month of available assets against the matching monthly burn rate resolves to exactly AVERAGE_DAYS_PER_MONTH days", () => {
    const monthlyBurn = agorot(1_000_000);
    const result = calculateLiquidityRunway(breakdown(1_000_000, 0), monthlyBurn);
    expect(result.runwayDays).toBeCloseTo(AVERAGE_DAYS_PER_MONTH, 9);
  });

  it("doubling available assets exactly doubles the runway (linearity)", () => {
    const burn = agorot(20_000);
    const single = calculateLiquidityRunway(breakdown(60_000, 0), burn);
    const doubled = calculateLiquidityRunway(breakdown(120_000, 0), burn);
    expect(doubled.runwayDays).toBeCloseTo((single.runwayDays ?? 0) * 2, 9);
  });

  it("halving the burn rate exactly doubles the runway (linearity)", () => {
    const available = breakdown(100_000, 0);
    const normal = calculateLiquidityRunway(available, agorot(40_000));
    const halvedBurn = calculateLiquidityRunway(available, agorot(20_000));
    expect(halvedBurn.runwayDays).toBeCloseTo((normal.runwayDays ?? 0) * 2, 9);
  });

  it("returns the inputs it was given verbatim in the result, for a caller that wants to display them alongside runwayDays", () => {
    const result = calculateLiquidityRunway(breakdown(10_000, 20_000, 30_000), agorot(5_000));
    expect(result.availableAgorot).toBe(30_000);
    expect(result.monthlyBurnRateAgorot).toBe(5_000);
  });
});
