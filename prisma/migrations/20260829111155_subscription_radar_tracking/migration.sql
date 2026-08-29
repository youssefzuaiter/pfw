-- CreateEnum
CREATE TYPE "SubscriptionReviewStatus" AS ENUM ('ACTIVE', 'REVIEWED', 'CANCELLED');

-- CreateTable
CREATE TABLE "SubscriptionTracking" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "merchantKey" TEXT NOT NULL,
    "status" "SubscriptionReviewStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionTracking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubscriptionTracking_userId_idx" ON "SubscriptionTracking"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionTracking_userId_merchantKey_key" ON "SubscriptionTracking"("userId", "merchantKey");

-- AddForeignKey
ALTER TABLE "SubscriptionTracking" ADD CONSTRAINT "SubscriptionTracking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security. SubscriptionTracking is user-scoped financial data
-- (a user's own subscription review/cancellation decisions), so it gets
-- the same tenant_isolation policy every other user-owned table has
-- (20260827133632_rls_and_runtime_role). FORCE matters too — without it
-- the table owner bypasses the policy.
ALTER TABLE "SubscriptionTracking" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SubscriptionTracking" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SubscriptionTracking"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));
