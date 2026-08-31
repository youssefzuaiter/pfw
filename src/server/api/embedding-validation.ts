import "server-only";
import { z } from "zod";
import { LOCAL_EMBEDDING_DIMENSIONS } from "../../lib/embeddings/embedding-model";

/**
 * Server-side shape validation for a client-computed embedding vector
 * (AGENTS.md §3u, §3aa) — the server can't verify a submitted array is a
 * *genuine* model output (there's no way to re-derive it without running
 * the same model), but every value crossing this trust boundary is still
 * validated: a wrong-length or non-finite array can only fail the
 * request, never silently corrupt a stored reference vector or crash the
 * KNN cosine-similarity computation later (`cosineSimilarity` throws on
 * a length mismatch, which would otherwise turn one bad client into a
 * 500 for every future categorization that happens to pull in that row).
 *
 * `EMBEDDING_DIMENSIONS` imports `LOCAL_EMBEDDING_DIMENSIONS` directly
 * from `src/lib/embeddings/embedding-model.ts` rather than duplicating
 * it — that sibling module is a pure constant with no browser
 * dependency, unlike `local-embedder.ts` itself (still barred from
 * `src/server/**` by tests/guards/local-embedder-client-only.test.ts),
 * so importing it doesn't need the "duplicate the constant instead"
 * trade-off the zero-knowledge vault's PBKDF2 iteration floor (§3m) and
 * the Dead Man's Switch's canary plaintext (§3t) still make for values
 * that truly do live only inside a client-only module.
 */
export const EMBEDDING_DIMENSIONS = LOCAL_EMBEDDING_DIMENSIONS;

export const EmbeddingSchema = z.array(z.number().finite()).length(EMBEDDING_DIMENSIONS).optional();
