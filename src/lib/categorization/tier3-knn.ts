import { cosineSimilarity } from "../vector-math";
import type { CategorySuggestion, EmbeddingCorrection } from "./types";

const DEFAULT_K = 5;
/** Neighbors below this similarity are treated as "not actually similar" and excluded from the vote. */
const DEFAULT_MIN_SIMILARITY = 0.75;

/**
 * Tier 3 — K-nearest-neighbors over previously-corrected merchant
 * embeddings (384-dimension vectors from the ONNX sidecar). Finds the `k`
 * most similar past merchants, drops any below `minSimilarity`, and takes
 * a similarity-weighted vote among what's left — so two neighbors at 0.95
 * similarity outvote three at 0.76, rather than every neighbor counting
 * equally regardless of how close it actually is.
 */
export function knnCategorize(
  targetEmbedding: readonly number[],
  corrections: readonly EmbeddingCorrection[],
  options: { k?: number; minSimilarity?: number } = {},
): CategorySuggestion | null {
  if (corrections.length === 0) return null;

  const k = options.k ?? DEFAULT_K;
  const minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;

  const neighbors = corrections
    .map((correction) => ({
      categoryId: correction.categoryId,
      similarity: cosineSimilarity(targetEmbedding, correction.embedding),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k)
    .filter((neighbor) => neighbor.similarity >= minSimilarity);

  if (neighbors.length === 0) return null;

  const weightByCategory = new Map<string, number>();
  for (const neighbor of neighbors) {
    weightByCategory.set(neighbor.categoryId, (weightByCategory.get(neighbor.categoryId) ?? 0) + neighbor.similarity);
  }

  const [topCategoryId, topWeight] = [...weightByCategory.entries()].sort((a, b) => b[1] - a[1])[0];
  const totalWeight = neighbors.reduce((sum, n) => sum + n.similarity, 0);

  return {
    categoryId: topCategoryId,
    confidence: topWeight / totalWeight,
    tier: 3,
    reason: `${neighbors.length} similar past merchant(s), top similarity ${neighbors[0].similarity.toFixed(3)}`,
  };
}
