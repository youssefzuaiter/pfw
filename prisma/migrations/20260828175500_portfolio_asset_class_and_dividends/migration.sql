-- Investment portfolio & dividend tracking (AGENTS.md §3l).
--
-- PortfolioHolding gains an asset class (stock/ETF/crypto), and a new
-- user-scoped Dividend table records declared and paid distributions.

-- CreateEnum
CREATE TYPE "AssetClass" AS ENUM ('STOCK', 'ETF', 'CRYPTO');

-- CreateEnum
CREATE TYPE "DividendStatus" AS ENUM ('ANNOUNCED', 'PAID');

-- AlterTable
-- Existing holdings are all US equities, so STOCK is the correct backfill,
-- not merely a convenient default.
ALTER TABLE "PortfolioHolding" ADD COLUMN "assetClass" "AssetClass" NOT NULL DEFAULT 'STOCK';

-- CreateTable
CREATE TABLE "Dividend" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "portfolioHoldingId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'USD',
    "amountPerShareNative" BIGINT NOT NULL,
    "exDate" TIMESTAMP(3) NOT NULL,
    "payDate" TIMESTAMP(3) NOT NULL,
    "status" "DividendStatus" NOT NULL DEFAULT 'ANNOUNCED',
    "quantityAtPayment" DECIMAL(20,8),
    "totalNativeAmount" BIGINT,
    "totalAgorot" BIGINT,
    "exchangeRateAtEntry" DECIMAL(12,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dividend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Dividend_userId_payDate_idx" ON "Dividend"("userId", "payDate");

-- CreateIndex
CREATE INDEX "Dividend_userId_portfolioHoldingId_idx" ON "Dividend"("userId", "portfolioHoldingId");

-- CreateIndex
CREATE UNIQUE INDEX "Dividend_userId_symbol_exDate_key" ON "Dividend"("userId", "symbol", "exDate");

-- AddForeignKey
ALTER TABLE "Dividend" ADD CONSTRAINT "Dividend_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dividend" ADD CONSTRAINT "Dividend_portfolioHoldingId_fkey" FOREIGN KEY ("portfolioHoldingId") REFERENCES "PortfolioHolding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security. Dividend is user-scoped financial data, so it gets
-- the same tenant_isolation policy every other user-owned table has
-- (20260827133632_rls_and_runtime_role). This is NOT optional boilerplate:
-- without it this table would be the one hole in the RLS layer, and the
-- DAL's own `where: { userId }` would become the only thing standing
-- between users' dividend records. `FORCE` matters too — without it the
-- table owner bypasses the policy.
ALTER TABLE "Dividend" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Dividend" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Dividend"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));
