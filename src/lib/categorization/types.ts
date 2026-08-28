export type CategorySuggestion = {
  categoryId: string;
  /** 0..1 */
  confidence: number;
  tier: 1 | 2 | 3 | 4;
  reason: string;
};

/** A prior transaction for the same merchant, used by Tier 1. */
export type PastOccurrence = {
  categoryId: string;
  isManual: boolean;
};

export type CategoryRule = {
  categorySlug: string;
  keywords: readonly string[];
};

/** A previously-corrected merchant's embedding, used by Tier 3's KNN vote. */
export type EmbeddingCorrection = {
  categoryId: string;
  embedding: readonly number[];
};

/**
 * Tier 4 — the LLM fallback. Deliberately an injected function, not a
 * direct Anthropic SDK call: this module is pure inference logic (Phase
 * 3); the real implementation (reading ANTHROPIC_API_KEY via
 * src/server/env.ts, calling the API) is wired in Phase 4 alongside the
 * route handler that has an actual request/response cycle to stream
 * through. Returns `null` to mean "no confident suggestion" — never
 * throws for an ordinary "couldn't decide" outcome.
 */
export type LlmCategorizer = (input: {
  merchantText: string;
  candidateCategories: ReadonlyArray<{ id: string; name: string }>;
}) => Promise<{ categoryId: string; confidence: number } | null>;
