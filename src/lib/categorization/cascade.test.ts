import { describe, expect, it, vi } from "vitest";
import { categorizeTransaction } from "./cascade";

const baseInput = {
  merchantText: "מסעדה לא ידועה",
  pastOccurrences: [],
  resolveCategoryIdBySlug: () => undefined,
  uncategorizedCategoryId: "cat-uncategorized",
};

describe("categorizeTransaction() cascade", () => {
  it("Tier 1 wins when a confident manual correction exists, even if a rule would also match", async () => {
    const result = await categorizeTransaction({
      ...baseInput,
      merchantText: "רמי לוי", // would match the groceries rule
      pastOccurrences: [
        { categoryId: "cat-custom", isManual: true },
        { categoryId: "cat-custom", isManual: true },
      ],
      resolveCategoryIdBySlug: () => "cat-groceries",
    });
    expect(result).toMatchObject({ categoryId: "cat-custom", tier: 1 });
  });

  it("falls through to Tier 2 when Tier 1 has no confident match", async () => {
    const result = await categorizeTransaction({
      ...baseInput,
      merchantText: "רמי לוי סניף מרכז",
      resolveCategoryIdBySlug: (slug) => (slug === "groceries" ? "cat-groceries" : undefined),
    });
    expect(result).toMatchObject({ categoryId: "cat-groceries", tier: 2 });
  });

  it("falls through past a Tier 2 rule match when the user has no category for that slug", async () => {
    const llmCategorizer = vi.fn().mockResolvedValue(null);
    const result = await categorizeTransaction({
      ...baseInput,
      merchantText: "רמי לוי",
      resolveCategoryIdBySlug: () => undefined, // user deleted/renamed the groceries category's slug mapping
      llmCategorizer,
    });
    expect(llmCategorizer).toHaveBeenCalled();
    expect(result.categoryId).toBe("cat-uncategorized");
  });

  it("falls through to Tier 3 (KNN) when no rule matches", async () => {
    const result = await categorizeTransaction({
      ...baseInput,
      merchantText: "מסעדה חדשה ומוזרה",
      merchantEmbedding: [1, 0, 0],
      embeddingCorrections: [{ categoryId: "cat-dining", embedding: [1, 0, 0] }],
    });
    expect(result).toMatchObject({ categoryId: "cat-dining", tier: 3 });
  });

  it("falls through to Tier 4 (LLM) when Tiers 1-3 all miss", async () => {
    const llmCategorizer = vi.fn().mockResolvedValue({ categoryId: "cat-guessed", confidence: 0.6 });
    const result = await categorizeTransaction({ ...baseInput, llmCategorizer });
    expect(llmCategorizer).toHaveBeenCalledWith(
      expect.objectContaining({ merchantText: baseInput.merchantText }),
    );
    expect(result).toMatchObject({ categoryId: "cat-guessed", tier: 4, confidence: 0.6 });
  });

  it("falls back to the uncategorized category when every tier misses", async () => {
    const result = await categorizeTransaction(baseInput);
    expect(result).toMatchObject({ categoryId: "cat-uncategorized", confidence: 0 });
  });

  it("never calls the LLM when an earlier tier already produced a result", async () => {
    const llmCategorizer = vi.fn();
    await categorizeTransaction({
      ...baseInput,
      merchantText: "רמי לוי",
      resolveCategoryIdBySlug: () => "cat-groceries",
      llmCategorizer,
    });
    expect(llmCategorizer).not.toHaveBeenCalled();
  });
});
