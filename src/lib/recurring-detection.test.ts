import { describe, expect, it } from "vitest";
import { detectRecurring, findRecurringMerchants, groupByMerchant } from "./recurring-detection";
import { agorot } from "./money";

function date(iso: string): Date {
  return new Date(iso);
}

describe("detectRecurring()", () => {
  it("flags a merchant with 3+ distinct months and a stable amount as recurring", () => {
    const result = detectRecurring({
      merchantKey: "netflix",
      occurrences: [
        { amount: agorot(4990), occurredAt: date("2026-06-05") },
        { amount: agorot(4990), occurredAt: date("2026-07-05") },
        { amount: agorot(4990), occurredAt: date("2026-08-05") },
      ],
    });

    expect(result.isRecurring).toBe(true);
    expect(result.distinctMonths).toBe(3);
    expect(result.coefficientOfVariation).toBe(0);
    expect(result.averageAmount).toBe(4990);
    expect(result.averageIntervalDays).toBeCloseTo(30.5, 0);
  });

  it("does not flag a merchant seen in fewer than 3 distinct months", () => {
    const result = detectRecurring({
      merchantKey: "one-off-store",
      occurrences: [
        { amount: agorot(5000), occurredAt: date("2026-08-01") },
        { amount: agorot(5000), occurredAt: date("2026-08-15") },
      ],
    });

    expect(result.isRecurring).toBe(false);
    expect(result.distinctMonths).toBe(1);
  });

  it("does not flag a merchant with high amount variability (ordinary variable spending)", () => {
    const result = detectRecurring({
      merchantKey: "groceries-store",
      occurrences: [
        { amount: agorot(12000), occurredAt: date("2026-06-03") },
        { amount: agorot(45000), occurredAt: date("2026-07-10") },
        { amount: agorot(8000), occurredAt: date("2026-08-20") },
      ],
    });

    expect(result.isRecurring).toBe(false);
    expect(result.coefficientOfVariation).toBeGreaterThan(0.15);
  });

  it("tolerates small realistic amount fluctuation just under the CV threshold", () => {
    const result = detectRecurring({
      merchantKey: "utility-bill",
      occurrences: [
        { amount: agorot(20000), occurredAt: date("2026-06-01") },
        { amount: agorot(20500), occurredAt: date("2026-07-01") },
        { amount: agorot(19800), occurredAt: date("2026-08-01") },
      ],
    });

    expect(result.isRecurring).toBe(true);
  });

  it("returns null averageIntervalDays with fewer than 2 occurrences", () => {
    const result = detectRecurring({
      merchantKey: "single",
      occurrences: [{ amount: agorot(1000), occurredAt: date("2026-08-01") }],
    });
    expect(result.averageIntervalDays).toBeNull();
  });

  it("counts multiple occurrences in the same month as one distinct month", () => {
    const result = detectRecurring({
      merchantKey: "twice-in-a-month",
      occurrences: [
        { amount: agorot(1000), occurredAt: date("2026-08-01") },
        { amount: agorot(1000), occurredAt: date("2026-08-20") },
      ],
    });
    expect(result.distinctMonths).toBe(1);
  });

  it("computes averageIntervalDays with exactly 2 occurrences (not just 3+)", () => {
    const result = detectRecurring({
      merchantKey: "two-occurrences",
      occurrences: [
        { amount: agorot(1000), occurredAt: date("2026-07-01") },
        { amount: agorot(1000), occurredAt: date("2026-08-01") },
      ],
    });
    expect(result.averageIntervalDays).toBe(31);
  });

  it("sorts occurrences by date before computing intervals, regardless of input order", () => {
    const chronological = detectRecurring({
      merchantKey: "chronological",
      occurrences: [
        { amount: agorot(1000), occurredAt: date("2026-06-01") },
        { amount: agorot(1000), occurredAt: date("2026-07-01") },
        { amount: agorot(1000), occurredAt: date("2026-08-01") },
      ],
    });
    const shuffled = detectRecurring({
      merchantKey: "shuffled",
      occurrences: [
        { amount: agorot(1000), occurredAt: date("2026-08-01") },
        { amount: agorot(1000), occurredAt: date("2026-06-01") },
        { amount: agorot(1000), occurredAt: date("2026-07-01") },
      ],
    });
    expect(shuffled.averageIntervalDays).toBe(chronological.averageIntervalDays);
    // A naive (non-sorting) interval calc over the shuffled order would
    // produce negative gaps and a very different (wrong) average.
    expect(shuffled.averageIntervalDays).toBeGreaterThan(0);
  });

  it("handles an empty occurrences array without crashing", () => {
    const result = detectRecurring({ merchantKey: "empty", occurrences: [] });
    expect(result.isRecurring).toBe(false);
    expect(result.coefficientOfVariation).toBe(Infinity);
    expect(result.averageAmount).toBe(0);
    expect(result.averageIntervalDays).toBeNull();
  });
});

describe("groupByMerchant()", () => {
  it("groups occurrences by merchant key", () => {
    const groups = groupByMerchant([
      { merchantKey: "a", amount: agorot(100), occurredAt: date("2026-01-01") },
      { merchantKey: "b", amount: agorot(200), occurredAt: date("2026-01-01") },
      { merchantKey: "a", amount: agorot(100), occurredAt: date("2026-02-01") },
    ]);

    expect(groups).toHaveLength(2);
    const merchantA = groups.find((g) => g.merchantKey === "a");
    expect(merchantA?.occurrences).toHaveLength(2);
  });
});

describe("findRecurringMerchants()", () => {
  it("returns only merchants flagged recurring, filtering out one-offs", () => {
    const results = findRecurringMerchants([
      { merchantKey: "netflix", amount: agorot(4990), occurredAt: date("2026-06-05") },
      { merchantKey: "netflix", amount: agorot(4990), occurredAt: date("2026-07-05") },
      { merchantKey: "netflix", amount: agorot(4990), occurredAt: date("2026-08-05") },
      { merchantKey: "one-off-store", amount: agorot(5000), occurredAt: date("2026-08-01") },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].merchantKey).toBe("netflix");
  });
});
