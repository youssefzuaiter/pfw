import { describe, expect, it } from "vitest";
import { createSeededRandom } from "./monte-carlo";
import { allocateProportionally, categoryLabel, categoryParts, describeSplitError, planSplits, primaryPart } from "./transaction-splits";

describe("allocateProportionally", () => {
  it("splits evenly divisible amounts exactly", () => {
    expect(allocateProportionally(-1000n, [1n, 1n])).toEqual([-500n, -500n]);
  });

  it("gives the leftover agorot to the largest remainders, earlier first on a tie", () => {
    // 100 / 3 = 33.33 each: one agorah left over, to the first part.
    expect(allocateProportionally(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    // 10 × 2/3 = 6.67 and 10 × 1/3 = 3.33: the larger remainder wins.
    expect(allocateProportionally(10n, [2n, 1n])).toEqual([7n, 3n]);
  });

  it("always adds up to the total, for any amounts and weights", () => {
    const random = createSeededRandom(42);
    for (let trial = 0; trial < 2_000; trial++) {
      const total = BigInt(Math.floor(random() * 10_000_000)) * (random() < 0.5 ? -1n : 1n);
      const count = 2 + Math.floor(random() * 6);
      const weights = Array.from({ length: count }, () => 1n + BigInt(Math.floor(random() * 1_000_000)));
      const parts = allocateProportionally(total, weights);
      expect(parts.reduce((sum, part) => sum + part, 0n)).toBe(total);
      for (const part of parts) if (part !== 0n) expect(part < 0n).toBe(total < 0n);
    }
  });

  it("refuses an empty or non-positive weight list", () => {
    expect(() => allocateProportionally(10n, [])).toThrow(RangeError);
    expect(() => allocateProportionally(10n, [1n, 0n])).toThrow(RangeError);
  });
});

describe("planSplits", () => {
  const shekels = { amount: -12_550n, nativeAmount: -12_550n, currency: "ILS" };

  it("signs the parts like the transaction and keeps agorot equal to the typed amount for shekels", () => {
    const plan = planSplits(shekels, [
      { categoryId: "groceries", nativeAmount: 10_000n },
      { categoryId: "household", nativeAmount: 2_550n },
    ]);
    expect(plan).toEqual({
      ok: true,
      parts: [
        { categoryId: "groceries", amount: -10_000n, nativeAmount: -10_000n },
        { categoryId: "household", amount: -2_550n, nativeAmount: -2_550n },
      ],
    });
  });

  it("refuses parts that are one agorah short or one agorah over", () => {
    const short = planSplits(shekels, [
      { categoryId: "groceries", nativeAmount: 10_000n },
      { categoryId: "household", nativeAmount: 2_549n },
    ]);
    expect(short).toEqual({ ok: false, error: "sum_mismatch", expected: 12_550n, actual: 12_549n });
    const over = planSplits(shekels, [
      { categoryId: "groceries", nativeAmount: 10_000n },
      { categoryId: "household", nativeAmount: 2_551n },
    ]);
    expect(over).toMatchObject({ ok: false, error: "sum_mismatch", actual: 12_551n });
  });

  it("refuses one part, a repeated category, and a zero part", () => {
    expect(planSplits(shekels, [{ categoryId: "groceries", nativeAmount: 12_550n }])).toMatchObject({ error: "too_few_parts" });
    expect(
      planSplits(shekels, [
        { categoryId: "groceries", nativeAmount: 6_000n },
        { categoryId: "groceries", nativeAmount: 6_550n },
      ]),
    ).toMatchObject({ error: "duplicate_category" });
    expect(
      planSplits(shekels, [
        { categoryId: "groceries", nativeAmount: 12_550n },
        { categoryId: "household", nativeAmount: 0n },
      ]),
    ).toMatchObject({ error: "non_positive_part" });
  });

  it("divides a foreign row's stored agorot so they add up exactly, whatever the rate's rounding", () => {
    // ₺100.00 stored as ₪6.23: three equal parts can't each be ₪2.0766…
    const lira = { amount: -623n, nativeAmount: -10_000n, currency: "TRY" };
    const plan = planSplits(lira, [
      { categoryId: "a", nativeAmount: 3_334n },
      { categoryId: "b", nativeAmount: 3_333n },
      { categoryId: "c", nativeAmount: 3_333n },
    ]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.parts.reduce((sum, part) => sum + part.amount, 0n)).toBe(-623n);
    expect(plan.parts.reduce((sum, part) => sum + part.nativeAmount, 0n)).toBe(-10_000n);
    expect(plan.parts.map((part) => part.amount)).toEqual([-208n, -208n, -207n]);
  });

  it("refuses a foreign part too small to be worth an agorah", () => {
    const lira = { amount: -623n, nativeAmount: -10_000n, currency: "TRY" };
    expect(
      planSplits(lira, [
        { categoryId: "a", nativeAmount: 9_999n },
        { categoryId: "b", nativeAmount: 1n },
      ]),
    ).toMatchObject({ ok: false, error: "part_too_small", categoryId: "b" });
  });

  it("splits income too, keeping it positive", () => {
    const plan = planSplits({ amount: 50_000n, nativeAmount: 50_000n, currency: "ILS" }, [
      { categoryId: "salary", nativeAmount: 45_000n },
      { categoryId: "bonus", nativeAmount: 5_000n },
    ]);
    expect(plan.ok && plan.parts.every((part) => part.amount > 0n)).toBe(true);
  });
});

describe("categoryParts and labels", () => {
  it("reads an unsplit row as one part and a split row as its parts", () => {
    expect(categoryParts({ categoryId: "c", amount: -10n, nativeAmount: -10n })).toEqual([{ categoryId: "c", amount: -10n, nativeAmount: -10n }]);
    const splits = [
      { categoryId: "a", amount: -3n, nativeAmount: -3n },
      { categoryId: "b", amount: -7n, nativeAmount: -7n },
    ];
    expect(categoryParts({ categoryId: "b", amount: -10n, nativeAmount: -10n, splits })).toEqual(splits);
    expect(primaryPart(splits).categoryId).toBe("b");
  });

  it("labels a split row largest part first", () => {
    expect(
      categoryLabel({
        category: { name: "Household" },
        splits: [
          { amount: -300n, category: { name: "Household" } },
          { amount: -700n, category: { name: "Groceries" } },
        ],
      }),
    ).toBe("Split: Groceries, Household");
    expect(categoryLabel({ category: { name: "Rent" }, splits: [] })).toBe("Rent");
  });

  it("names the difference when the parts don't add up", () => {
    const format = (minor: bigint) => `₪${(Number(minor) / 100).toFixed(2)}`;
    expect(describeSplitError({ error: "sum_mismatch", expected: 12_550n, actual: 12_549n }, format)).toBe(
      "The parts add up to ₪125.49, ₪0.01 short of the transaction's ₪125.50.",
    );
  });
});
