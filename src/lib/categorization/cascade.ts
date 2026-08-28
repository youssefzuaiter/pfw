import { findManualCorrection } from "./tier1-manual";
import { DEFAULT_CATEGORY_RULES, matchCategoryRule } from "./tier2-rules";
import { knnCategorize } from "./tier3-knn";
import type { CategoryRule, CategorySuggestion, EmbeddingCorrection, LlmCategorizer, PastOccurrence } from "./types";

export type CascadeInput = {
  merchantText: string;
  /** Tier 1 input — this user's past occurrences of the same merchant. */
  pastOccurrences: readonly PastOccurrence[];
  /** Tier 2 input — defaults to DEFAULT_CATEGORY_RULES. */
  rules?: readonly CategoryRule[];
  /** Tier 2 needs to turn a rule's permanent slug into this user's actual category row ID. */
  resolveCategoryIdBySlug: (slug: string) => string | undefined;
  /** Tier 3 inputs — both must be present for Tier 3 to run at all. */
  merchantEmbedding?: readonly number[];
  embeddingCorrections?: readonly EmbeddingCorrection[];
  /** Tier 4 — omit to skip straight to the uncategorized fallback. */
  llmCategorizer?: LlmCategorizer;
  /** Every user has exactly one of these (see schema.prisma Category model). */
  uncategorizedCategoryId: string;
  /** Only used if llmCategorizer is provided, to build its candidate list. */
  candidateCategories?: ReadonlyArray<{ id: string; name: string }>;
};

/**
 * Runs the 4-tier categorization cascade, stopping at the first tier that
 * produces a confident suggestion: manual corrections (Tier 1) →
 * deterministic keyword rules (Tier 2) → KNN over embeddings (Tier 3) →
 * LLM fallback (Tier 4). Falls back to the user's Uncategorized category
 * (confidence 0) if nothing matches, which is also how a transaction ends
 * up in the "needs review" queue.
 */
export async function categorizeTransaction(input: CascadeInput): Promise<CategorySuggestion> {
  const tier1 = findManualCorrection(input.pastOccurrences);
  if (tier1) return tier1;

  const ruleMatch = matchCategoryRule(input.merchantText, input.rules ?? DEFAULT_CATEGORY_RULES);
  if (ruleMatch) {
    const categoryId = input.resolveCategoryIdBySlug(ruleMatch.categorySlug);
    if (categoryId) {
      return {
        categoryId,
        confidence: 0.9,
        tier: 2,
        reason: `matched keyword "${ruleMatch.keyword}" for category "${ruleMatch.categorySlug}"`,
      };
    }
    // Rule matched a slug this user doesn't have a category for (e.g. a
    // custom category set) — fall through to the remaining tiers rather
    // than erroring.
  }

  if (input.merchantEmbedding && input.embeddingCorrections?.length) {
    const tier3 = knnCategorize(input.merchantEmbedding, input.embeddingCorrections);
    if (tier3) return tier3;
  }

  if (input.llmCategorizer) {
    const tier4 = await input.llmCategorizer({
      merchantText: input.merchantText,
      candidateCategories: input.candidateCategories ?? [],
    });
    if (tier4) {
      return { categoryId: tier4.categoryId, confidence: tier4.confidence, tier: 4, reason: "LLM fallback" };
    }
  }

  return {
    categoryId: input.uncategorizedCategoryId,
    confidence: 0,
    tier: 4,
    reason: "no tier produced a confident match; flagged for manual review",
  };
}
