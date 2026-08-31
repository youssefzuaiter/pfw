/**
 * Shared, side-effect-free embedding constants — deliberately its own
 * file, separate from local-embedder.ts, so BOTH client and server code
 * can import it directly. local-embedder.ts (and its worker) touch real
 * browser/WASM APIs and are barred from src/server/** by
 * tests/guards/local-embedder-client-only.test.ts; this file touches
 * nothing but string/number literals, so it needs no such guard and
 * removes the "duplicate the constant instead of importing the
 * client-only module" trade-off src/server/api/embedding-validation.ts
 * used to have to make (AGENTS.md §3u/§3m/§3t all document that same
 * trade-off elsewhere — this file is what avoids it here).
 *
 * CURRENT_EMBEDDING_MODEL_ID is the one place this app decides which
 * model's vectors are considered comparable right now. Bumping it here
 * is the ENTIRE migration story for a future model swap: every existing
 * MerchantEmbedding row tagged with the old id simply stops being
 * eligible for KNN voting (src/server/dal/merchant-embeddings.ts's
 * listEmbeddingCorrections filters on this id) rather than being
 * silently compared, via cosine similarity, against a vector from a
 * completely different embedding space — a comparison that produces a
 * meaningless number, not a low one, so leaving it unfiltered would risk
 * confidently-wrong categorization, not just a missed match.
 */

export const CURRENT_EMBEDDING_MODEL_ID = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

export const LOCAL_EMBEDDING_DIMENSIONS = 384;
