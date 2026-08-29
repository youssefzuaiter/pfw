import { describe, expect, it } from "vitest";
import { agorot } from "./money";
import {
  createSeededRandom,
  DEFAULT_MONTE_CARLO_ASSUMPTIONS,
  runMonteCarloSimulation,
  type MonteCarloInput,
} from "./monte-carlo";

/** A full set of valid defaults, overridden per-test via spread. */
function baseInput(overrides: Partial<MonteCarloInput> = {}): MonteCarloInput {
  return {
    ...DEFAULT_MONTE_CARLO_ASSUMPTIONS,
    startingNetWorthAgorot: agorot(50_000_00),
    currentAge: 40,
    retirementAge: 65,
    endAge: 90,
    annualSavingsAgorot: agorot(2_000_00),
    annualSpendAgorot: agorot(1_500_00),
    growthAllocationShare: 0.6,
    numSimulations: 300,
    ...overrides,
  };
}

describe("runMonteCarloSimulation", () => {
  it("returns one yearly-percentile entry per age from currentAge to endAge, inclusive", () => {
    const result = runMonteCarloSimulation(baseInput({ currentAge: 40, endAge: 45 }));
    expect(result.yearlyPercentiles).toHaveLength(6);
    expect(result.yearlyPercentiles.map((p) => p.age)).toEqual([40, 41, 42, 43, 44, 45]);
  });

  it("every path starts at exactly the starting net worth (age currentAge is deterministic)", () => {
    const result = runMonteCarloSimulation(baseInput({ startingNetWorthAgorot: agorot(12_345_00) }));
    const first = result.yearlyPercentiles[0];
    expect(first.p10).toBe(12_345_00);
    expect(first.p50).toBe(12_345_00);
    expect(first.p90).toBe(12_345_00);
  });

  it("is fully deterministic under zero variance (guaranteed growth, no crash risk)", () => {
    const input = baseInput({
      growthReturnMean: 0.08,
      growthReturnStdDev: 0,
      cashReturnMean: 0.03,
      cashReturnStdDev: 0,
      inflationMean: 0.02,
      inflationStdDev: 0,
      growthAllocationShare: 1,
      currentAge: 60,
      retirementAge: 65,
      endAge: 66,
      annualSavingsAgorot: agorot(0),
      annualSpendAgorot: agorot(100_00),
      startingNetWorthAgorot: agorot(1_000_000_00),
    });
    const result = runMonteCarloSimulation(input);
    // Real return each year is exactly 8% - 2% = 6%, deterministically, regardless of `Math.random`.
    expect(result.probabilityOfSuccess).toBe(1);
    expect(result.yearlyPercentiles[1].p10).toBe(result.yearlyPercentiles[1].p90);
  });

  it("a guaranteed severe crash with any retirement spending drives probability of success to 0", () => {
    const result = runMonteCarloSimulation(
      baseInput({
        growthReturnMean: -0.9,
        growthReturnStdDev: 0,
        cashReturnMean: -0.9,
        cashReturnStdDev: 0,
        inflationMean: 0,
        inflationStdDev: 0,
        currentAge: 65,
        retirementAge: 65,
        endAge: 90,
        annualSpendAgorot: agorot(100_00),
        startingNetWorthAgorot: agorot(1_000_00),
      }),
    );
    expect(result.probabilityOfSuccess).toBe(0);
  });

  it("guaranteed strong growth with zero retirement spending always succeeds", () => {
    const result = runMonteCarloSimulation(
      baseInput({
        growthReturnMean: 0.1,
        growthReturnStdDev: 0,
        cashReturnMean: 0.1,
        cashReturnStdDev: 0,
        inflationMean: 0,
        inflationStdDev: 0,
        currentAge: 65,
        retirementAge: 65,
        endAge: 90,
        annualSpendAgorot: agorot(0),
        startingNetWorthAgorot: agorot(1_000_00),
      }),
    );
    expect(result.probabilityOfSuccess).toBe(1);
  });

  it("zero starting net worth, zero savings, and any retirement spend always fails", () => {
    const result = runMonteCarloSimulation(
      baseInput({
        startingNetWorthAgorot: agorot(0),
        annualSavingsAgorot: agorot(0),
        currentAge: 65,
        retirementAge: 65,
        annualSpendAgorot: agorot(1_00),
      }),
    );
    expect(result.probabilityOfSuccess).toBe(0);
    expect(result.medianFinalBalance).toBe(0);
  });

  it("zero savings during working years doesn't throw and still produces a valid result", () => {
    const result = runMonteCarloSimulation(baseInput({ annualSavingsAgorot: agorot(0) }));
    expect(result.probabilityOfSuccess).toBeGreaterThanOrEqual(0);
    expect(result.probabilityOfSuccess).toBeLessThanOrEqual(1);
  });

  it("handles an already-retired scenario (currentAge >= retirementAge) as pure decumulation", () => {
    const result = runMonteCarloSimulation(
      baseInput({ currentAge: 70, retirementAge: 65, endAge: 90, annualSavingsAgorot: agorot(0) }),
    );
    expect(result.yearlyPercentiles[0].age).toBe(70);
    expect(Number.isFinite(result.probabilityOfSuccess)).toBe(true);
  });

  it("isolates growthAllocationShare = 0 to only the cash distribution", () => {
    const result = runMonteCarloSimulation(
      baseInput({
        growthAllocationShare: 0,
        growthReturnMean: 999, // absurd — must have zero effect at share = 0
        growthReturnStdDev: 0,
        cashReturnMean: 0.05,
        cashReturnStdDev: 0,
        inflationMean: 0,
        inflationStdDev: 0,
        currentAge: 65,
        retirementAge: 65,
        endAge: 66,
        annualSpendAgorot: agorot(0),
        startingNetWorthAgorot: agorot(1_000_00),
      }),
    );
    // Exactly a 5% real return applied once: ₪1000 (100,000 agorot) * 1.05 = 105,000 agorot.
    expect(result.yearlyPercentiles[1].p50).toBe(105_000);
  });

  it("isolates growthAllocationShare = 1 to only the growth distribution", () => {
    const result = runMonteCarloSimulation(
      baseInput({
        growthAllocationShare: 1,
        cashReturnMean: 999, // absurd — must have zero effect at share = 1
        cashReturnStdDev: 0,
        growthReturnMean: 0.05,
        growthReturnStdDev: 0,
        inflationMean: 0,
        inflationStdDev: 0,
        currentAge: 65,
        retirementAge: 65,
        endAge: 66,
        annualSpendAgorot: agorot(0),
        startingNetWorthAgorot: agorot(1_000_00),
      }),
    );
    expect(result.yearlyPercentiles[1].p50).toBe(105_000);
  });

  it("does not throw and stays numerically sane under extreme volatility (a market-crash stress test)", () => {
    const result = runMonteCarloSimulation(
      baseInput({
        growthReturnStdDev: 5, // 500% standard deviation — deliberately absurd
        cashReturnStdDev: 5,
        inflationStdDev: 3,
        numSimulations: 500,
      }),
    );
    expect(result.probabilityOfSuccess).toBeGreaterThanOrEqual(0);
    expect(result.probabilityOfSuccess).toBeLessThanOrEqual(1);
    for (const point of result.yearlyPercentiles) {
      expect(Number.isSafeInteger(point.p10)).toBe(true);
      expect(Number.isSafeInteger(point.p50)).toBe(true);
      expect(Number.isSafeInteger(point.p90)).toBe(true);
      expect(point.p10).toBeLessThanOrEqual(point.p50);
      expect(point.p50).toBeLessThanOrEqual(point.p90);
    }
  });

  it("is reproducible: the same seed and inputs produce an identical result", () => {
    const makeInput = () => baseInput({ randomFn: createSeededRandom(42), numSimulations: 200 });
    const resultA = runMonteCarloSimulation(makeInput());
    const resultB = runMonteCarloSimulation(makeInput());
    expect(resultA).toEqual(resultB);
  });

  it("different seeds produce different (but both valid) results", () => {
    const resultA = runMonteCarloSimulation(baseInput({ randomFn: createSeededRandom(1), numSimulations: 200 }));
    const resultB = runMonteCarloSimulation(baseInput({ randomFn: createSeededRandom(2), numSimulations: 200 }));
    expect(resultA).not.toEqual(resultB);
  });

  it("higher retirement spending never increases the probability of success, all else equal", () => {
    const lowSpend = runMonteCarloSimulation(
      baseInput({ randomFn: createSeededRandom(7), annualSpendAgorot: agorot(1_000_00) }),
    );
    const highSpend = runMonteCarloSimulation(
      baseInput({ randomFn: createSeededRandom(7), annualSpendAgorot: agorot(10_000_00) }),
    );
    expect(highSpend.probabilityOfSuccess).toBeLessThanOrEqual(lowSpend.probabilityOfSuccess);
  });

  it("higher annual savings never decreases the probability of success, all else equal", () => {
    const lowSavings = runMonteCarloSimulation(
      baseInput({ randomFn: createSeededRandom(11), annualSavingsAgorot: agorot(0) }),
    );
    const highSavings = runMonteCarloSimulation(
      baseInput({ randomFn: createSeededRandom(11), annualSavingsAgorot: agorot(20_000_00) }),
    );
    expect(highSavings.probabilityOfSuccess).toBeGreaterThanOrEqual(lowSavings.probabilityOfSuccess);
  });

  it("createSeededRandom produces values in [0, 1) across many draws", () => {
    const random = createSeededRandom(123);
    for (let i = 0; i < 1000; i++) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  describe("input validation", () => {
    it("rejects endAge <= currentAge", () => {
      expect(() => runMonteCarloSimulation(baseInput({ currentAge: 50, endAge: 50 }))).toThrow(RangeError);
      expect(() => runMonteCarloSimulation(baseInput({ currentAge: 50, endAge: 49 }))).toThrow(RangeError);
    });

    it("rejects a negative currentAge", () => {
      expect(() => runMonteCarloSimulation(baseInput({ currentAge: -1 }))).toThrow(RangeError);
    });

    it("rejects a non-integer age", () => {
      expect(() => runMonteCarloSimulation(baseInput({ currentAge: 40.5 }))).toThrow(RangeError);
    });

    it("rejects a horizon longer than the maximum simulated years", () => {
      expect(() => runMonteCarloSimulation(baseInput({ currentAge: 0, endAge: 200 }))).toThrow(RangeError);
    });

    it("rejects zero or negative numSimulations", () => {
      expect(() => runMonteCarloSimulation(baseInput({ numSimulations: 0 }))).toThrow(RangeError);
      expect(() => runMonteCarloSimulation(baseInput({ numSimulations: -5 }))).toThrow(RangeError);
    });

    it("rejects numSimulations above the hard cap", () => {
      expect(() => runMonteCarloSimulation(baseInput({ numSimulations: 50_000 }))).toThrow(RangeError);
    });

    it("rejects negative annualSavingsAgorot", () => {
      expect(() => runMonteCarloSimulation(baseInput({ annualSavingsAgorot: agorot(-1) }))).toThrow(RangeError);
    });

    it("rejects negative annualSpendAgorot", () => {
      expect(() => runMonteCarloSimulation(baseInput({ annualSpendAgorot: agorot(-1) }))).toThrow(RangeError);
    });

    it("rejects growthAllocationShare outside [0, 1]", () => {
      expect(() => runMonteCarloSimulation(baseInput({ growthAllocationShare: -0.1 }))).toThrow(RangeError);
      expect(() => runMonteCarloSimulation(baseInput({ growthAllocationShare: 1.1 }))).toThrow(RangeError);
    });

    it("rejects a negative standard deviation for any of the three distributions", () => {
      expect(() => runMonteCarloSimulation(baseInput({ growthReturnStdDev: -0.01 }))).toThrow(RangeError);
      expect(() => runMonteCarloSimulation(baseInput({ cashReturnStdDev: -0.01 }))).toThrow(RangeError);
      expect(() => runMonteCarloSimulation(baseInput({ inflationStdDev: -0.01 }))).toThrow(RangeError);
    });
  });
});
