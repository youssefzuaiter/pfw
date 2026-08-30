-- Self-Learning Vector Categorization Engine (AGENTS.md §3u).
--
-- Adds `categoryId`/`updatedAt` to `MerchantEmbedding`, required (no
-- default) rather than nullable: this table has never been read or
-- written by any application code path before this pass (verified by
-- grep, not assumed — every prior "384-dimension embedding" mention in
-- this codebase described the interface, never a real call site), so
-- there are zero existing rows this NOT NULL constraint could violate.
-- Generated via `prisma migrate diff` against the live dev database —
-- `prisma migrate dev` refuses to run non-interactively for the same
-- reason as every migration in this history since the household-spaces
-- one: a prior migration was hand-edited after being applied, which
-- invalidates the shadow-database replay `migrate dev` needs.
--
-- No RLS changes needed: `MerchantEmbedding` already has the standard
-- tenant_isolation policy from the original RLS migration, which covers
-- every column on the table, including these two new ones.

-- AlterTable
ALTER TABLE "MerchantEmbedding" ADD COLUMN     "categoryId" TEXT NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateIndex
CREATE INDEX "MerchantEmbedding_categoryId_idx" ON "MerchantEmbedding"("categoryId");

-- AddForeignKey
ALTER TABLE "MerchantEmbedding" ADD CONSTRAINT "MerchantEmbedding_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

