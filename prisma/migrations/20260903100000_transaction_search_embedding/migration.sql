-- Enables pgvector and adds a semantic-search index column to
-- NotableTransaction (AGENTS.md §3cc). `IF NOT EXISTS` on the extension
-- is idempotent by design — matches the existing schema's convention of
-- guarding schema-level side effects (compare the RLS migrations'
-- `IF NOT EXISTS` role-creation guards).
--
-- No ANN index (HNSW/IVFFlat) added here on purpose: this app's own
-- established scale reasoning (a personal ledger, not millions of rows —
-- the exact same call already made for MerchantEmbedding's in-memory KNN
-- scan, AGENTS.md §3u) applies here too. A plain sequential scan via the
-- `<=>` operator is correct and fast enough at this scale; add
-- `CREATE INDEX ... USING hnsw (searchEmbedding vector_cosine_ops)` in a
-- follow-up migration if real row counts ever justify the added
-- complexity of tuning an ANN index.
--
-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- AlterTable
ALTER TABLE "NotableTransaction" ADD COLUMN     "searchEmbedding" vector(384);
