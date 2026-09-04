-- CreateEnum
CREATE TYPE "LedgerCommitAction" AS ENUM ('CREATE', 'UPDATE');

-- CreateTable
CREATE TABLE "LedgerCommit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "action" "LedgerCommitAction" NOT NULL,
    "previousHash" TEXT,
    "currentHash" TEXT NOT NULL,
    "patchData" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerCommit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LedgerCommit_userId_transactionId_createdAt_idx" ON "LedgerCommit"("userId", "transactionId", "createdAt");

-- AddForeignKey
ALTER TABLE "LedgerCommit" ADD CONSTRAINT "LedgerCommit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerCommit" ADD CONSTRAINT "LedgerCommit_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "NotableTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- LedgerCommit is append-only, same enforcement pattern as AuditLog
-- (prisma/migrations/20260827133632_rls_and_runtime_role): pfw_runtime
-- may SELECT and INSERT, never UPDATE/DELETE. Privilege-based
-- enforcement is the primary control; the trigger below is a second,
-- independent layer in case grants are ever misconfigured. This is what
-- actually makes the hash chain tamper-EVIDENT rather than tamper-
-- theater — without it, the same actor able to alter a transaction
-- could just as easily rewrite the chain to match.
REVOKE UPDATE, DELETE ON "LedgerCommit" FROM pfw_runtime;

CREATE OR REPLACE FUNCTION prevent_ledger_commit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'LedgerCommit is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_commit_append_only ON "LedgerCommit";
CREATE TRIGGER ledger_commit_append_only
  BEFORE UPDATE OR DELETE ON "LedgerCommit"
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_commit_mutation();

ALTER TABLE "LedgerCommit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LedgerCommit" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "LedgerCommit"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));
