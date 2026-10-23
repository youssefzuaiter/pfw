-- A hand-added item belongs to either the Bills page or the Subscriptions page
-- (AGENTS.md §3eeee). Everything saved before this existed was added on the
-- Bills page, so it stays a bill. A new column on an existing table needs no
-- new grants.

-- CreateEnum
CREATE TYPE "RecurringBillKind" AS ENUM ('BILL', 'SUBSCRIPTION');

-- AlterTable
ALTER TABLE "RecurringBill" ADD COLUMN     "kind" "RecurringBillKind" NOT NULL DEFAULT 'BILL';
