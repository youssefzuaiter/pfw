-- CreateTable
CREATE TABLE "EquityQuote" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "priceUsd" DECIMAL(20,6) NOT NULL,
    "asOfDate" DATE NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EquityQuote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EquityQuote_symbol_observedAt_idx" ON "EquityQuote"("symbol", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EquityQuote_symbol_asOfDate_key" ON "EquityQuote"("symbol", "asOfDate");


-- Public market data (no userId, no RLS — same as ExchangeRate/CryptoAssetPrice).
-- The runtime role's DML is granted explicitly rather than left to ALTER DEFAULT
-- PRIVILEGES: on the production (Neon) database that default did not cover
-- RateLimitBucket and the grant had to be applied by hand (AGENTS.md §3uu).
GRANT SELECT, INSERT, UPDATE, DELETE ON "EquityQuote" TO pfw_runtime;
