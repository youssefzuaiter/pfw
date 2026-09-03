-- Zero-Sum Envelope Budgeting migration: creates EnvelopeAllocation,
-- backfills one baseline allocation per existing Budget row for the
-- CURRENT calendar month (so existing users don't start with zeroed
-- envelopes), then drops the old Budget table. Order matters: the new
-- table must exist and be populated BEFORE Budget is dropped, so the
-- diff tool's own drop-first ordering is hand-reordered here.

-- CreateTable
CREATE TABLE "EnvelopeAllocation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "amountAgorot" BIGINT NOT NULL,
    "month" TEXT NOT NULL,
    "sharedGroupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnvelopeAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EnvelopeAllocation_userId_categoryId_idx" ON "EnvelopeAllocation"("userId", "categoryId");

-- CreateIndex
CREATE INDEX "EnvelopeAllocation_userId_month_idx" ON "EnvelopeAllocation"("userId", "month");

-- CreateIndex
CREATE INDEX "EnvelopeAllocation_sharedGroupId_idx" ON "EnvelopeAllocation"("sharedGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "EnvelopeAllocation_userId_categoryId_month_key" ON "EnvelopeAllocation"("userId", "categoryId", "month");

-- AddForeignKey
ALTER TABLE "EnvelopeAllocation" ADD CONSTRAINT "EnvelopeAllocation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvelopeAllocation" ADD CONSTRAINT "EnvelopeAllocation_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvelopeAllocation" ADD CONSTRAINT "EnvelopeAllocation_sharedGroupId_fkey" FOREIGN KEY ("sharedGroupId") REFERENCES "SharedGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Data migration: one baseline EnvelopeAllocation per existing Budget
-- row, dated to the CURRENT calendar month (to_char(now(), 'YYYY-MM'),
-- matching src/lib/date-month.ts's own UTC-anchored format) so an
-- existing user's rolling balance starts from their prior monthlyLimit
-- rather than zero the moment this migration applies. gen_random_uuid()
-- is used for the id (built into Postgres 13+ core, no extension
-- needed) since Prisma's `@default(cuid())` is an application-level
-- default with no DB-level equivalent for a raw INSERT to rely on.
INSERT INTO "EnvelopeAllocation" ("id", "userId", "categoryId", "amountAgorot", "month", "sharedGroupId", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, "userId", "categoryId", "monthlyLimit", to_char(now(), 'YYYY-MM'), "sharedGroupId", now(), now()
FROM "Budget";

-- DropForeignKey
ALTER TABLE "Budget" DROP CONSTRAINT "Budget_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "Budget" DROP CONSTRAINT "Budget_sharedGroupId_fkey";

-- DropForeignKey
ALTER TABLE "Budget" DROP CONSTRAINT "Budget_userId_fkey";

-- DropTable
DROP TABLE "Budget";

-- Row-Level Security. EnvelopeAllocation preserves Budget's own
-- household-sharing capability (AGENTS.md §3s) — same 4-way
-- select/insert/update/delete policy split as Budget had
-- (20260829120000_shared_household_spaces), not the simpler single
-- tenant_isolation policy, because a shared allocation must stay
-- readable by every group member and writable by a WRITE-permission
-- member who doesn't own the row. `pfw_is_group_member`/
-- `pfw_can_write_group` are the same SECURITY DEFINER helper functions
-- that migration already created — reused here unchanged, not
-- redefined.
ALTER TABLE "EnvelopeAllocation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EnvelopeAllocation" FORCE ROW LEVEL SECURITY;

CREATE POLICY select_scope ON "EnvelopeAllocation" FOR SELECT
  USING (
    "userId" = current_setting('app.current_user_id', true)
    OR ("sharedGroupId" IS NOT NULL AND pfw_is_group_member("sharedGroupId"))
  );

CREATE POLICY insert_scope ON "EnvelopeAllocation" FOR INSERT
  WITH CHECK (
    "userId" = current_setting('app.current_user_id', true)
    AND ("sharedGroupId" IS NULL OR pfw_is_group_member("sharedGroupId"))
  );

CREATE POLICY update_scope ON "EnvelopeAllocation" FOR UPDATE
  USING (
    ("userId" = current_setting('app.current_user_id', true) AND ("sharedGroupId" IS NULL OR pfw_is_group_member("sharedGroupId")))
    OR ("userId" != current_setting('app.current_user_id', true) AND "sharedGroupId" IS NOT NULL AND pfw_can_write_group("sharedGroupId"))
  )
  WITH CHECK (
    ("userId" = current_setting('app.current_user_id', true) AND ("sharedGroupId" IS NULL OR pfw_is_group_member("sharedGroupId")))
    OR ("userId" != current_setting('app.current_user_id', true) AND "sharedGroupId" IS NOT NULL AND pfw_can_write_group("sharedGroupId"))
  );

CREATE POLICY delete_scope ON "EnvelopeAllocation" FOR DELETE
  USING (
    "userId" = current_setting('app.current_user_id', true)
    OR ("sharedGroupId" IS NOT NULL AND pfw_can_write_group("sharedGroupId"))
  );
