import { describe, expect, it } from "vitest";
import { averageDailyNet, compareForecasts, MINIMUM_NOTEWORTHY_GAP_MINOR } from "./forecast-comparison";

describe("compareForecasts", () => {
  it("explains two forecasts that end on opposite sides of today's cash", () => {
    // Today $721; the known-commitments forecast ends at -$385, the pattern one near +$5,000.
    expect(compareForecasts({ startingMinor: 72_100, knownMinor: -38_500, patternMinor: 500_000 })).toEqual({ oppositeDirections: true });
  });

  it("explains a big gap even when both go the same way", () => {
    expect(compareForecasts({ startingMinor: 100_000, knownMinor: 150_000, patternMinor: 400_000 })).toEqual({ oppositeDirections: false });
  });

  it("says nothing when the forecasts agree closely", () => {
    expect(compareForecasts({ startingMinor: 100_000, knownMinor: 90_000, patternMinor: 92_000 })).toBeNull();
  });

  it("ignores a gap that is small in money, however large relative to a tiny balance", () => {
    const gap = MINIMUM_NOTEWORTHY_GAP_MINOR - 1;
    expect(compareForecasts({ startingMinor: 0, knownMinor: 0, patternMinor: gap })).toBeNull();
    expect(compareForecasts({ startingMinor: 0, knownMinor: 0, patternMinor: MINIMUM_NOTEWORTHY_GAP_MINOR })).not.toBeNull();
  });

  it("needs the gap to be a tenth of the larger balance too", () => {
    // 5,000.00 apart is under a tenth of 100,000.00 .
    expect(compareForecasts({ startingMinor: 10_000_000, knownMinor: 10_000_000, patternMinor: 10_500_000 })).toBeNull();
    expect(compareForecasts({ startingMinor: 10_000_000, knownMinor: 10_000_000, patternMinor: 11_200_000 })).not.toBeNull();
  });

  it("treats a forecast that ends exactly where it started as not opposite", () => {
    expect(compareForecasts({ startingMinor: 100_000, knownMinor: 100_000, patternMinor: 400_000 })).toEqual({ oppositeDirections: false });
  });

  it("refuses to compare when a figure is missing", () => {
    expect(compareForecasts({ startingMinor: 1, knownMinor: Number.NaN, patternMinor: 5 })).toBeNull();
  });
});

describe("averageDailyNet", () => {
  it("averages and rounds", () => {
    expect(averageDailyNet([100, 200, 301])).toBe(200);
    expect(averageDailyNet([-50, -52])).toBe(-51);
  });

  it("is zero for no history", () => {
    expect(averageDailyNet([])).toBe(0);
  });
});
