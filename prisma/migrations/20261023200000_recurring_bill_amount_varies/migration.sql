-- A hand-added bill can be marked as billed by use (AGENTS.md §3jjjj): its
-- amount is different every time, so its payments are recognised by name and
-- the amount it is expected to cost is the average of its last few real
-- payments. Everything saved before this keeps a fixed amount. A new column on
-- an existing table needs no new grants.

-- AlterTable
ALTER TABLE "RecurringBill" ADD COLUMN     "amountVaries" BOOLEAN NOT NULL DEFAULT false;
