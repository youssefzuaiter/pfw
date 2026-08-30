-- Real-Time Liquidity Runway & Burn-Rate Engine (AGENTS.md §3v).
--
-- `ManualAsset.liquidityTier` is nullable — no backfill needed, unlike
-- the multi-currency migration's (§3k) required-column case: null has a
-- real, correct meaning here ("derive the tier from assetType"), so
-- every pre-existing seeded row is already valid with no data to fill
-- in. Generated via `prisma migrate diff` against the live dev database,
-- same "prisma migrate dev refuses to run non-interactively" situation
-- as every migration since the household-spaces one.
--
-- No RLS changes needed: `ManualAsset` already has the standard
-- tenant_isolation policy, which covers this new column too.

-- CreateEnum
CREATE TYPE "LiquidityTier" AS ENUM ('LIQUID', 'SEMI_LIQUID', 'ILLIQUID');

-- AlterTable
ALTER TABLE "ManualAsset" ADD COLUMN     "liquidityTier" "LiquidityTier";

