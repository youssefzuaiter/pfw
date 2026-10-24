import { describe, expect, it } from "vitest";
import { ROUND_UP_TO_AGOROT, suggestEnvelopeAmounts } from "./envelope-suggestions";

describe("suggestEnvelopeAmounts", () => {
  it("averages over the months with activity and rounds up to the next ten shekels", () => {
    const result = suggestEnvelopeAmounts(new Map([["groceries", 150_000 + 162_000 + 171_000]]), 3);
    expect(result).toEqual([{ categoryId: "groceries", averageAgorot: 161_000, suggestedAgorot: 161_000 }]);
    const odd = suggestEnvelopeAmounts(new Map([["dining", 100_500 + 100_500 + 100_500]]), 3);
    expect(odd[0]).toMatchObject({ averageAgorot: 100_500, suggestedAgorot: 101_000 });
  });

  it("does not count months with no activity as zero spending", () => {
    expect(suggestEnvelopeAmounts(new Map([["rent", 300_000]]), 1)[0].averageAgorot).toBe(300_000);
    expect(suggestEnvelopeAmounts(new Map([["rent", 300_000]]), 3)[0].averageAgorot).toBe(100_000);
  });

  it("suggests nothing without any history, or for a category with no spending", () => {
    expect(suggestEnvelopeAmounts(new Map([["a", 5_000]]), 0)).toEqual([]);
    expect(suggestEnvelopeAmounts(new Map([["a", 0], ["b", -5]]), 3)).toEqual([]);
  });

  it("leaves out an average that rounds to nothing", () => {
    expect(suggestEnvelopeAmounts(new Map([["tiny", 1]]), 3)).toEqual([]);
  });

  it("never rounds below the average, and an exact multiple stays", () => {
    for (const total of [1, 999, 1_000, 1_001, 5_432, 99_999]) {
      const [s] = suggestEnvelopeAmounts(new Map([["x", total * 3]]), 3);
      expect(s.suggestedAgorot).toBeGreaterThanOrEqual(s.averageAgorot);
      expect(s.suggestedAgorot - s.averageAgorot).toBeLessThan(ROUND_UP_TO_AGOROT);
      expect(s.suggestedAgorot % ROUND_UP_TO_AGOROT).toBe(0);
    }
  });

  it("lists the biggest first, ties by id", () => {
    const result = suggestEnvelopeAmounts(new Map([["b", 30_000], ["a", 30_000], ["c", 90_000]]), 1);
    expect(result.map((s) => s.categoryId)).toEqual(["c", "a", "b"]);
  });
});
