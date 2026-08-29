-- Multi-currency support (AGENTS.md §3k) — BankAccount, NotableTransaction,
-- PortfolioHolding, Trade gain a `currency` + native-minor-units
-- representation alongside their existing ILS-agorot figures, and a new
-- global (non-user-scoped) ExchangeRate table backs the conversion.
--
-- New required columns are added nullable first, backfilled, then set
-- NOT NULL — this dev database already has seeded demo rows (all ILS
-- accounts/transactions, all USD trades at the historical mock rate of
-- 3.7 ILS/USD baked into src/lib/mock-market-data.ts before this change),
-- so a plain `ADD COLUMN ... NOT NULL` with no default would fail exactly
-- as `prisma migrate dev` reported. Every backfilled value here is
-- consistent with what the app would have computed itself at insert time
-- under the old single-currency assumption.

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('ILS', 'USD', 'EUR', 'GBP');

-- BankAccount: rename currentBalance -> nativeBalance (all existing
-- accounts are ILS-native, so the value is unchanged, just relabeled).
ALTER TABLE "BankAccount"
  ADD COLUMN "currency" "Currency" NOT NULL DEFAULT 'ILS',
  ADD COLUMN "nativeBalance" BIGINT;

UPDATE "BankAccount" SET "nativeBalance" = "currentBalance";

ALTER TABLE "BankAccount"
  ALTER COLUMN "nativeBalance" SET NOT NULL,
  DROP COLUMN "currentBalance";

-- NotableTransaction: existing rows are all ILS-native, so nativeAmount
-- mirrors amount exactly and exchangeRateAtEntry stays NULL (rate is
-- trivially 1 for ILS, per the model's own doc comment).
ALTER TABLE "NotableTransaction"
  ADD COLUMN "currency" "Currency" NOT NULL DEFAULT 'ILS',
  ADD COLUMN "exchangeRateAtEntry" DECIMAL(12,6),
  ADD COLUMN "nativeAmount" BIGINT;

UPDATE "NotableTransaction" SET "nativeAmount" = "amount";

ALTER TABLE "NotableTransaction"
  ALTER COLUMN "nativeAmount" SET NOT NULL;

-- PortfolioHolding: existing holdings are USD equities whose totalCostBasis
-- was computed via the historical mock rate of 3.7 ILS/USD — invert that
-- same rate to backfill the native (USD cents) total.
ALTER TABLE "PortfolioHolding"
  ADD COLUMN "currency" "Currency" NOT NULL DEFAULT 'USD',
  ADD COLUMN "nativeCostBasis" BIGINT;

UPDATE "PortfolioHolding"
  SET "nativeCostBasis" = ROUND(("totalCostBasis"::numeric) / 3.7)::bigint;

ALTER TABLE "PortfolioHolding"
  ALTER COLUMN "nativeCostBasis" SET NOT NULL;

-- Trade: same historical 3.7 ILS/USD rate applied to every existing
-- execution's price/total/realized-PnL to derive its native-USD figures,
-- and recorded as this row's own exchangeRateAtEntry (an honest
-- historical fact — that rate really is what mock-market-data.ts used at
-- the time every one of these mock trades was seeded).
ALTER TABLE "Trade"
  ADD COLUMN "currency" "Currency" NOT NULL DEFAULT 'USD',
  ADD COLUMN "exchangeRateAtEntry" DECIMAL(12,6),
  ADD COLUMN "nativePriceAmount" BIGINT,
  ADD COLUMN "nativeTotalAmount" BIGINT,
  ADD COLUMN "nativeRealizedPnl" BIGINT;

UPDATE "Trade"
  SET
    "exchangeRateAtEntry" = 3.7,
    "nativePriceAmount" = ROUND(("priceAgorot"::numeric) / 3.7)::bigint,
    "nativeTotalAmount" = ROUND(("totalAgorot"::numeric) / 3.7)::bigint,
    "nativeRealizedPnl" = CASE
      WHEN "realizedPnlAgorot" IS NULL THEN NULL
      ELSE ROUND(("realizedPnlAgorot"::numeric) / 3.7)::bigint
    END;

ALTER TABLE "Trade"
  ALTER COLUMN "exchangeRateAtEntry" SET NOT NULL,
  ALTER COLUMN "nativePriceAmount" SET NOT NULL,
  ALTER COLUMN "nativeTotalAmount" SET NOT NULL;

-- CreateTable
CREATE TABLE "ExchangeRate" (
    "id" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "rate" DECIMAL(12,6) NOT NULL,
    "asOfDate" DATE NOT NULL,
    "source" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExchangeRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExchangeRate_currency_asOfDate_idx" ON "ExchangeRate"("currency", "asOfDate");

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeRate_currency_asOfDate_key" ON "ExchangeRate"("currency", "asOfDate");

-- ExchangeRate is deliberately NOT given RLS — it holds no user data (see
-- its schema.prisma model comment). pfw_runtime already gets
-- SELECT/INSERT/UPDATE/DELETE on it via the blanket
-- "ALTER DEFAULT PRIVILEGES ... GRANT ... ON TABLES" set up in
-- 20260827133632_rls_and_runtime_role, so no additional GRANT is needed
-- here.
