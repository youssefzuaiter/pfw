-- Advanced Crypto & On-Chain Asset Tracking module (AGENTS.md §3w).
--
-- The two ALTER COLUMN statements widen PortfolioHolding/Trade.quantity
-- from Decimal(20,8) to Decimal(30,18) — a safe, lossless widening for
-- every existing row (Postgres preserves an existing `numeric` value
-- exactly when both precision and scale increase; verified after
-- applying by reading the actual migrated seeded rows back, not just
-- assumed). Everything from "CreateTable" onward is Prisma-generated,
-- via `prisma migrate diff` against the live dev database — same
-- non-interactive `prisma migrate dev` situation as every migration in
-- this history since the household-spaces one. The Row-Level Security
-- section below is hand-written, same established pattern as every
-- other migration that touches RLS.

-- AlterTable
ALTER TABLE "PortfolioHolding" ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(30,18);

-- AlterTable
ALTER TABLE "Trade" ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(30,18);

-- CreateTable
CREATE TABLE "CryptoAssetPrice" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "rate" DECIMAL(20,6) NOT NULL,
    "asOfDate" DATE NOT NULL,
    "source" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CryptoAssetPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CryptoWallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL DEFAULT 1,
    "label" TEXT NOT NULL,
    "stakingYieldBps" INTEGER,
    "cumulativeGasFeesWei" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CryptoWallet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CryptoAssetPrice_symbol_asOfDate_idx" ON "CryptoAssetPrice"("symbol", "asOfDate");

-- CreateIndex
CREATE UNIQUE INDEX "CryptoAssetPrice_symbol_asOfDate_key" ON "CryptoAssetPrice"("symbol", "asOfDate");

-- CreateIndex
CREATE INDEX "CryptoWallet_userId_idx" ON "CryptoWallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CryptoWallet_userId_address_chainId_key" ON "CryptoWallet"("userId", "address", "chainId");

-- AddForeignKey
ALTER TABLE "CryptoWallet" ADD CONSTRAINT "CryptoWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security. CryptoWallet is user-scoped financial data (which
-- addresses a user chose to track), so it gets the standard single
-- tenant_isolation policy every plain user-owned table gets. FORCE
-- matters too — without it the table owner bypasses the policy.
ALTER TABLE "CryptoWallet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CryptoWallet" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "CryptoWallet"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- CryptoAssetPrice deliberately gets NO RLS policy at all — same
-- treatment ExchangeRate already has (public market data, no user
-- column to scope by). `pfw_runtime` already has DML on it for free via
-- the existing blanket ALTER DEFAULT PRIVILEGES grant.

