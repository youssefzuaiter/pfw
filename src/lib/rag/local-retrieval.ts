/**
 * The full client-side half of the Local RAG pipeline: embed the user's
 * question (via the existing client-side embedder,
 * `src/lib/embeddings/local-embedder.ts` — the same WASM model already
 * used for categorization, AGENTS.md §3u/§3bb), rank it against the
 * IndexedDB-cached transaction vectors (`local-vector-store.ts`), and
 * return the top-K matching transaction ids only — never the vectors,
 * never the query text, never the matched transactions' own text. This
 * is the one function the copilot sidebar calls; it never touches
 * IndexedDB or the embedder directly, so those two dependencies' own
 * client-only guards are what actually keep this whole pipeline off the
 * server, transitively.
 *
 * Enforced client-only by
 * tests/guards/local-retrieval-client-only.test.ts, same pattern as
 * every other browser-only module in this app.
 */

import { embedTextWithTimeout } from "../embeddings/local-embedder";
import { rankTransactionsBySimilarity, type RankOptions } from "./local-vector-search";
import { getCachedVectors } from "./local-vector-store";

/**
 * Resolves the transaction ids locally relevant to `query`, or an empty
 * array on ANY failure or empty-cache condition — an uninitialized/
 * empty vector cache, a slow/unavailable embedding model, or a genuinely
 * empty result set all degrade to the same "no local context available"
 * signal, so a caller never needs to distinguish them: the copilot
 * sidebar's job is simply to fall back to the standard, un-augmented
 * prompt whenever this returns `[]`.
 */
export async function retrieveRelevantTransactionIds(query: string, options?: RankOptions): Promise<string[]> {
  let vectors;
  try {
    vectors = await getCachedVectors();
  } catch {
    return [];
  }
  if (vectors.length === 0) return [];

  const queryEmbedding = await embedTextWithTimeout(query);
  if (!queryEmbedding) return [];

  return rankTransactionsBySimilarity(queryEmbedding, vectors, options).map((match) => match.transactionId);
}
