/**
 * Ranks a set of cached transaction vectors against one query embedding
 * by cosine similarity — the local KNN half of the Local RAG pipeline.
 * Pure, no browser API and no IndexedDB/model dependency at all (unlike
 * its siblings `local-vector-store.ts`/`local-retrieval.ts`), so — same
 * reasoning `src/lib/categorization/tier3-knn.ts` already gives for its
 * own KNN engine — this is directly unit-testable with plain array
 * literals and needs no client-only guard.
 *
 * A plain in-memory scan, not a dedicated Web Worker: this app's real
 * scale is a personal ledger (hundreds, not millions, of cached
 * vectors), and a cosine-similarity pass over even a few thousand
 * 384-dimension vectors is sub-millisecond work — the same
 * "application-code comparison, not a specialized index" call this
 * app's server-side pgvector search already makes at this same scale
 * (AGENTS.md §3cc: "no ANN index... a plain sequential scan is correct
 * and fast enough here too"). Reserve an actual Worker for genuinely
 * heavy, blocking work (WASM model inference, as `local-embedder.ts`
 * already does) — not for this.
 */

import { cosineSimilarity } from "../vector-math";
import type { CachedVector } from "./local-vector-store";

export const DEFAULT_TOP_K = 8;

/**
 * Cosine-similarity floor below which a match isn't considered
 * meaningfully relevant — mirrors the two other KNN-shaped thresholds
 * already established elsewhere in this app
 * (`src/lib/categorization/tier3-knn.ts`'s `DEFAULT_MIN_SIMILARITY` and
 * `src/server/dal/transactions.ts`'s `MAX_COSINE_DISTANCE = 0.25`, i.e.
 * `1 - 0.25 = 0.75` similarity) so every KNN-shaped feature in this app
 * agrees on what "actually similar" means, rather than each picking its
 * own number.
 */
export const DEFAULT_MIN_SIMILARITY = 0.75;

export type RankedTransaction = { transactionId: string; similarity: number };

export type RankOptions = {
  topK?: number;
  minSimilarity?: number;
};

/**
 * Ranks `vectors` by cosine similarity to `queryEmbedding`, most similar
 * first, filtered to `minSimilarity` and capped at `topK`. Silently
 * skips any cached vector whose dimensionality doesn't match the query
 * (a stale cache from a since-changed embedding model, AGENTS.md
 * §3bb/§3u — the same "exclude, don't crash" treatment
 * `listEmbeddingCorrections`'s server-side model-version filter already
 * gives this exact failure mode) rather than letting
 * `cosineSimilarity`'s length-mismatch throw take down the whole
 * ranking pass over one bad row.
 */
export function rankTransactionsBySimilarity(
  queryEmbedding: readonly number[],
  vectors: readonly CachedVector[],
  options: RankOptions = {},
): RankedTransaction[] {
  const topK = options.topK ?? DEFAULT_TOP_K;
  const minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;

  const ranked: RankedTransaction[] = [];
  for (const vector of vectors) {
    if (vector.embedding.length !== queryEmbedding.length) continue;
    const similarity = cosineSimilarity(queryEmbedding, vector.embedding);
    if (similarity >= minSimilarity) {
      ranked.push({ transactionId: vector.transactionId, similarity });
    }
  }

  ranked.sort((a, b) => b.similarity - a.similarity);
  return ranked.slice(0, topK);
}
