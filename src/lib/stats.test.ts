import { describe, expect, it } from "vitest";
import { coefficientOfVariation, mean, standardDeviation } from "./stats";

describe("mean()", () => {
  it("computes the arithmetic mean", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });

  it("rejects an empty array", () => {
    expect(() => mean([])).toThrow(RangeError);
  });
});

describe("standardDeviation()", () => {
  it("is zero for identical values", () => {
    expect(standardDeviation([5, 5, 5])).toBe(0);
  });

  it("matches a hand-computed population standard deviation", () => {
    // Values 2,4,4,4,5,5,7,9 -> mean 5, population variance 4, stddev 2.
    expect(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2, 10);
  });

  it("rejects an empty array", () => {
    expect(() => standardDeviation([])).toThrow(RangeError);
  });
});

describe("coefficientOfVariation()", () => {
  it("is low for tightly clustered values", () => {
    expect(coefficientOfVariation([100, 101, 99, 100])).toBeLessThan(0.05);
  });

  it("is high for widely varying values", () => {
    expect(coefficientOfVariation([10, 100, 5, 200])).toBeGreaterThan(0.5);
  });

  it("is Infinity when the mean is zero but values still vary, not NaN", () => {
    expect(coefficientOfVariation([-5, 5])).toBe(Infinity);
  });

  it("is Infinity (not NaN from a literal 0/0) when every value is exactly zero", () => {
    // This is the case the explicit `avg === 0` guard actually exists
    // for: with all-zero input, stddev is *also* 0, so without the
    // guard the natural division would be 0/0 = NaN, not Infinity. The
    // [-5, 5] case above doesn't exercise this — its stddev is nonzero,
    // so plain division already yields Infinity there with no guard
    // needed at all.
    expect(coefficientOfVariation([0, 0, 0])).toBe(Infinity);
  });
});
