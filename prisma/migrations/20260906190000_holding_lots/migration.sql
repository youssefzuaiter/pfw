-- Persisted per-lot cost-basis tracking for the Tier-0 paper-trading
-- agent's real settlement pipeline (ad hoc, Phase 2). Generated via
-- `prisma migrate diff` against the live dev DB — same established
-- workaround as every migration since §3p, since prior hand-edited
-- migrations in this history break `prisma migrate dev`'s shadow-
-- database replay — with the RLS block below added by hand afterward,
-- same workflow as every migration since.

-- CreateTable
CREATE TABLE "HoldingLot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "holdingId" TEXT NOT NULL,
    "quantity" DECIMAL(30,18) NOT NULL,
    "costBasis" BIGINT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HoldingLot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HoldingLot_userId_holdingId_quantity_idx" ON "HoldingLot"("userId", "holdingId", "quantity");

-- AddForeignKey
ALTER TABLE "HoldingLot" ADD CONSTRAINT "HoldingLot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HoldingLot" ADD CONSTRAINT "HoldingLot_holdingId_fkey" FOREIGN KEY ("holdingId") REFERENCES "PortfolioHolding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security. HoldingLot is user-scoped financial data (per-lot
-- cost basis for one account's own holdings), so it gets the standard
-- single tenant_isolation policy every plain user-owned table gets.
-- FORCE matters too — without it the table owner (pfw_app) bypasses the
-- policy. pfw_runtime already has full DML on this table for free via
-- the existing blanket ALTER DEFAULT PRIVILEGES grant (same precedent as
-- every other table added this way, e.g. CryptoWallet, ScenarioMetrics).
ALTER TABLE "HoldingLot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "HoldingLot" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "HoldingLot"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));
