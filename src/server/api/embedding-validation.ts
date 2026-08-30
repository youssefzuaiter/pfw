import "server-only";
import { z } from "zod";

/**
 * Server-side shape validation for a client-computed embedding vector
 * (AGENTS.md §3u) — the server can't verify a submitted array is a
 * *genuine* model output (there's no way to re-derive it without running
 * the same model), but every value crossing this trust boundary is still
 * validated: a wrong-length or non-finite array can only fail the
 * request, never silently corrupt a stored reference vector or crash the
 * KNN cosine-similarity computation later (`cosineSimilarity` throws on
 * a length mismatch, which would otherwise turn one bad client into a
 * 500 for every future categorization that happens to pull in that row).
 *
 * `EMBEDDING_DIMENSIONS` deliberately duplicates
 * src/lib/embeddings/local-embedder.ts's `LOCAL_EMBEDDING_DIMENSIONS`
 * rather than importing it — that module must never be imported from
 * `src/server/**` (tests/guards/local-embedder-client-only.test.ts),
 * same "duplicate the constant, never the client-only module" trade-off
 * already made for the zero-knowledge vault's PBKDF2 iteration floor
 * (§3m) and the Dead Man's Switch's canary plaintext (§3t).
 */
export const EMBEDDING_DIMENSIONS = 384;

export const EmbeddingSchema = z.array(z.number().finite()).length(EMBEDDING_DIMENSIONS).optional();
