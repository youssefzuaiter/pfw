-- Subscriptions and bills the user types in themselves (AGENTS.md §3cccc), and
-- the phone-alert state that reminds about them once per due date. One row of
-- RecurringBill is a schedule, never a transaction.

-- CreateEnum
CREATE TYPE "BillCadence" AS ENUM ('MONTHLY', 'QUARTERLY', 'ANNUAL');

-- AlterTable
ALTER TABLE "PhoneAlertSubscription" ADD COLUMN     "remindedBillKeys" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "RecurringBill" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nativeAmount" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'ILS',
    "cadence" "BillCadence" NOT NULL,
    "anchorDate" DATE NOT NULL,
    "categoryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringBill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecurringBill_userId_idx" ON "RecurringBill"("userId");

-- AddForeignKey
ALTER TABLE "RecurringBill" ADD CONSTRAINT "RecurringBill_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringBill" ADD CONSTRAINT "RecurringBill_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Per-user data: the standard single tenant_isolation policy, FORCEd so the
-- table owner does not bypass it.
ALTER TABLE "RecurringBill" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RecurringBill" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "RecurringBill"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- Both grants stated outright. Default privileges attach only to the role
-- that declared them, and on production the migrating role is not that role:
-- the §3uu outage (pfw_runtime) and the 2026-10-05 backup failure
-- (backup_reader, 20261011160000_backup_reader_core_tables) both came from
-- leaning on them.
GRANT SELECT, INSERT, UPDATE, DELETE ON "RecurringBill" TO pfw_runtime;
GRANT SELECT ON "RecurringBill" TO backup_reader;
