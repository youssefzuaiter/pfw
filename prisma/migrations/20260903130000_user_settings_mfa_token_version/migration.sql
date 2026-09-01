-- Punch List Tier 2: global per-user settings, server-side JWT revocation,
-- and TOTP MFA (AGENTS.md — this pass's own ad hoc section documents the
-- full design). Hand-written, same established pattern as every other
-- migration in this history that follows a prior hand-edited-post-apply
-- migration (`prisma migrate dev`'s shadow-database replay is broken by
-- that history — see AGENTS.md §3p's "migration-checksum incident" and
-- every subsequent migration's own header note).

-- CreateEnum
CREATE TYPE "CostBasisMethod" AS ENUM ('FIFO', 'LIFO');

-- CreateEnum
CREATE TYPE "TaxJurisdiction" AS ENUM ('US', 'DE', 'INTL');

-- CreateEnum
CREATE TYPE "CurrencyDisplayMode" AS ENUM ('NATIVE', 'ILS');

-- AlterTable
-- All four new User columns are additive with safe defaults/nulls, so no
-- backfill is needed: tokenVersion starts every existing user (and every
-- existing session's comparison) at 1, not 0 (a real, deliberate one-time
-- cutover — see the column's own schema doc comment for why 1 was chosen
-- over 0), and the three totp* columns are null/false for every user
-- until they opt into MFA.
ALTER TABLE "User" ADD COLUMN     "tokenVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "totpSecret" TEXT,
ADD COLUMN     "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "totpLastUsedTimeStep" INTEGER;

-- CreateTable
CREATE TABLE "UserSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "taxJurisdiction" "TaxJurisdiction" NOT NULL DEFAULT 'US',
    "taxMethod" "CostBasisMethod" NOT NULL DEFAULT 'FIFO',
    "taxOtherOrdinaryIncomeAgorot" BIGINT NOT NULL DEFAULT 0,
    "taxIncludeNiit" BOOLEAN NOT NULL DEFAULT false,
    "taxChurchTaxRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxAnnualAllowanceAgorot" BIGINT,
    "taxFlatRatePercent" DOUBLE PRECISION,
    "monteCarloRetirementAge" INTEGER NOT NULL DEFAULT 65,
    "monteCarloTargetAnnualSpendAgorot" BIGINT,
    "monteCarloVolatilityMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "defaultManualAssetLiquidityTier" "LiquidityTier",
    "preferredCurrencyDisplay" "CurrencyDisplayMode" NOT NULL DEFAULT 'ILS',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserSettings_userId_key" ON "UserSettings"("userId");

-- AddForeignKey
ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security. UserSettings is user-scoped data (one row per user),
-- so it gets the same single tenant_isolation policy every plain
-- user-owned table gets (20260827133632_rls_and_runtime_role) — no
-- "fellow member needs read access" case here, unlike the Household
-- Spaces tables (§3s), so no per-command split is needed either.
-- `pfw_runtime` already has full DML on this new table for free via the
-- existing `ALTER DEFAULT PRIVILEGES` blanket grant from that same
-- migration — confirmed by precedent (§3k's ExchangeRate note), not
-- re-verified live in this pass since this session has no Postgres
-- access (see the DAL/route code's own honesty note about what was and
-- wasn't verified live this pass).
ALTER TABLE "UserSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserSettings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "UserSettings"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));
