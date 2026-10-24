-- A debt payment can be recorded from a ledger transaction (AGENTS.md §3nnnn).
-- At most one payment per transaction, so a repayment is never recorded twice.
-- AlterTable
ALTER TABLE "DebtPayment" ADD COLUMN     "transactionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "DebtPayment_transactionId_key" ON "DebtPayment"("transactionId");

-- AddForeignKey
ALTER TABLE "DebtPayment" ADD CONSTRAINT "DebtPayment_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "NotableTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
