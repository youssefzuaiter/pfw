import { describe, expect, it } from "vitest";
import { agorot } from "./money";
import { calculateMonthlyBurnRate, type MonthlyExpense } from "./burn-rate";

function expense(monthKey: string, amount: number): MonthlyExpense {
  return { monthKey, expenseAgorot: agorot(amount) };
}

describe("calculateMonthlyBurnRate", () => {
  it("averages exactly the trailing N months, ignoring older history", () => {
    const history = [expense("2026-01", 100_000), expense("2026-02", 900_000), expense("2026-03", 200_000), expense("2026-04", 400_000)];
    // Trailing 3: Feb+Mar+Apr = 900k+200k+400k = 1,500,000 / 3 = 500,000. Jan (100k) must be excluded.
    const result = calculateMonthlyBurnRate(history, agorot(0), { trailingMonths: 3 });
    expect(result.monthlyBurnRateAgorot).toBe(500_000);
    expect(result.monthsAveraged).toBe(3);
    expect(result.source).toBe("historical_average");
  });

  it("defaults to a 3-month trailing window", () => {
    const history = [expense("2026-01", 300_000), expense("2026-02", 300_000), expense("2026-03", 300_000)];
    const result = calculateMonthlyBurnRate(history, agorot(0));
    expect(result.monthlyBurnRateAgorot).toBe(300_000);
    expect(result.monthsAveraged).toBe(3);
  });

  it("uses fewer months than requested when less history exists, without error", () => {
    const history = [expense("2026-03", 240_000)];
    const result = calculateMonthlyBurnRate(history, agorot(0), { trailingMonths: 3 });
    expect(result.monthlyBurnRateAgorot).toBe(240_000);
    expect(result.monthsAveraged).toBe(1);
  });

  it("with zero history and zero recurring commitments, reports zero burn with source 'none'", () => {
    const result = calculateMonthlyBurnRate([], agorot(0));
    expect(result).toEqual({ monthlyBurnRateAgorot: 0, source: "none", monthsAveraged: 0 });
  });

  it("with zero history, falls back entirely to the recurring-commitments floor", () => {
    const result = calculateMonthlyBurnRate([], agorot(150_000));
    expect(result.monthlyBurnRateAgorot).toBe(150_000);
    expect(result.source).toBe("recurring_commitments_floor");
    expect(result.monthsAveraged).toBe(0);
  });

  it("the recurring-commitments floor wins when it exceeds the historical average", () => {
    // A user who just signed up for a big new annual-equivalent monthly
    // commitment that hasn't shown up in 3 months of history yet.
    const history = [expense("2026-01", 100_000), expense("2026-02", 100_000), expense("2026-03", 100_000)];
    const result = calculateMonthlyBurnRate(history, agorot(500_000), { trailingMonths: 3 });
    expect(result.monthlyBurnRateAgorot).toBe(500_000);
    expect(result.source).toBe("recurring_commitments_floor");
  });

  it("the historical average wins when it exceeds recurring commitments", () => {
    const history = [expense("2026-01", 800_000), expense("2026-02", 800_000), expense("2026-03", 800_000)];
    const result = calculateMonthlyBurnRate(history, agorot(200_000), { trailingMonths: 3 });
    expect(result.monthlyBurnRateAgorot).toBe(800_000);
    expect(result.source).toBe("historical_average");
  });

  it("an exact tie between the historical average and the floor resolves to 'historical_average'", () => {
    const history = [expense("2026-01", 300_000), expense("2026-02", 300_000), expense("2026-03", 300_000)];
    const result = calculateMonthlyBurnRate(history, agorot(300_000), { trailingMonths: 3 });
    expect(result.monthlyBurnRateAgorot).toBe(300_000);
    expect(result.source).toBe("historical_average");
  });

  it("a genuine zero-spend month is averaged in as a real zero, correctly lowering the average", () => {
    const history = [expense("2026-01", 300_000), expense("2026-02", 0), expense("2026-03", 300_000)];
    const result = calculateMonthlyBurnRate(history, agorot(0), { trailingMonths: 3 });
    expect(result.monthlyBurnRateAgorot).toBe(200_000); // (300k + 0 + 300k) / 3
  });

  it("rounds a non-integer average to the nearest whole agorot rather than throwing", () => {
    const history = [expense("2026-01", 100_000), expense("2026-02", 100_001), expense("2026-03", 100_000)];
    const result = calculateMonthlyBurnRate(history, agorot(0), { trailingMonths: 3 });
    // (100000+100001+100000)/3 = 100000.333... -> rounds to 100000.
    expect(result.monthlyBurnRateAgorot).toBe(100_000);
    expect(Number.isInteger(result.monthlyBurnRateAgorot)).toBe(true);
  });

  it("rejects a non-positive or non-integer trailingMonths", () => {
    expect(() => calculateMonthlyBurnRate([], agorot(0), { trailingMonths: 0 })).toThrow(RangeError);
    expect(() => calculateMonthlyBurnRate([], agorot(0), { trailingMonths: -1 })).toThrow(RangeError);
    expect(() => calculateMonthlyBurnRate([], agorot(0), { trailingMonths: 1.5 })).toThrow(RangeError);
  });

  it("a trailingMonths larger than the entire history still just uses everything available", () => {
    const history = [expense("2026-01", 100_000), expense("2026-02", 300_000)];
    const result = calculateMonthlyBurnRate(history, agorot(0), { trailingMonths: 12 });
    expect(result.monthlyBurnRateAgorot).toBe(200_000);
    expect(result.monthsAveraged).toBe(2);
  });
});
