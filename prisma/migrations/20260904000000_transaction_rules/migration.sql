-- CreateTable
CREATE TABLE "TransactionRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "conditions" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransactionRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TransactionRule_userId_priority_idx" ON "TransactionRule"("userId", "priority");

-- AddForeignKey
ALTER TABLE "TransactionRule" ADD CONSTRAINT "TransactionRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security. TransactionRule is user-scoped financial-pipeline
-- configuration (a user's own Tier 0 categorization rules), so it gets
-- the same tenant_isolation policy every other single-owner user table
-- has (20260827133632_rls_and_runtime_role). FORCE matters too — without
-- it the table owner (pfw_app) bypasses the policy.
ALTER TABLE "TransactionRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TransactionRule" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "TransactionRule"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

