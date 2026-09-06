-- Structured AI-strategy telemetry from the Tier-0 paper-trading agent
-- (ad hoc). Generated via `prisma migrate diff` against the live dev DB
-- — same established workaround as every migration since §3p, since
-- prior hand-edited migrations in this history break `prisma migrate
-- dev`'s shadow-database replay — with the RLS block below added by
-- hand afterward, same workflow as every migration since.

-- CreateTable
CREATE TABLE "ScenarioMetrics" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "predictedMovePct" DECIMAL(8,4) NOT NULL,
    "actualFillPrice" DECIMAL(12,4),
    "decision" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScenarioMetrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScenarioMetrics_userId_ticker_createdAt_idx" ON "ScenarioMetrics"("userId", "ticker", "createdAt");

-- CreateIndex
CREATE INDEX "ScenarioMetrics_hash_idx" ON "ScenarioMetrics"("hash");

-- AddForeignKey
ALTER TABLE "ScenarioMetrics" ADD CONSTRAINT "ScenarioMetrics_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security. ScenarioMetrics is user-scoped agent telemetry
-- (specific to one account's own paper-trading activity, not shared
-- public data the way ExchangeRate/CryptoAssetPrice are), so it gets
-- the standard single tenant_isolation policy every plain user-owned
-- table gets. FORCE matters too — without it the table owner (pfw_app)
-- bypasses the policy. pfw_runtime already has full DML on this table
-- for free via the existing blanket ALTER DEFAULT PRIVILEGES grant
-- (confirmed by precedent — every other table added this way, e.g.
-- CryptoWallet, relies on the identical grant with no per-table GRANT
-- statement needed).
ALTER TABLE "ScenarioMetrics" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScenarioMetrics" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ScenarioMetrics"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));
