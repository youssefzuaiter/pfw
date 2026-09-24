-- Transfers, soft delete, and import batches (AGENTS.md §3ccc).
--
-- Adding enum values and the columns in one file is safe here because
-- nothing in this migration USES the new values — Postgres only forbids
-- using a value in the same transaction that adds it, which is why
-- 20260921090000_currency_try had to stand alone.
ALTER TYPE "LedgerCommitAction" ADD VALUE IF NOT EXISTS 'DELETE';
ALTER TYPE "LedgerCommitAction" ADD VALUE IF NOT EXISTS 'RESTORE';

-- isTransfer: money between the user's own accounts. Defaults false, so
-- every existing row keeps its current meaning and nothing is
-- reclassified silently.
-- deletedAt: soft delete. A hard delete is impossible anyway —
-- LedgerCommit cascades from this table and is append-only at the
-- database level, so the cascade is rejected by its own trigger.
-- importBatchId: groups one statement import so it can be undone whole.
ALTER TABLE "NotableTransaction"
  ADD COLUMN "isTransfer" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "deletedAt" TIMESTAMP(3),
  ADD COLUMN "importBatchId" TEXT;

CREATE INDEX "NotableTransaction_userId_importBatchId_idx"
  ON "NotableTransaction"("userId", "importBatchId");

-- A soft-deleted row must not keep reserving its dedupe key: undoing a
-- bad import has to leave the file importable again, or "undo" is
-- itself irreversible. The key is released on delete (set to NULL) and
-- recovered from the DELETE ledger commit on restore, so the unique
-- constraint above stays exactly as Prisma declares it.
