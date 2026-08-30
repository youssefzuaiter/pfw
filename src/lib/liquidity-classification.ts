import { addAgorot, type Agorot } from "./money";

/**
 * Asset-classification half of the Real-Time Liquidity Runway &
 * Burn-Rate Engine (AGENTS.md §3v). Pure functions over already-fetched
 * data, same `src/lib/` convention as every other engine (§3b) — no
 * DAL/DB access, so this is testable with plain data literals.
 */

export type LiquidityTier = "LIQUID" | "SEMI_LIQUID" | "ILLIQUID";

/**
 * `ManualAsset.assetType`'s default liquidity tier when
 * `ManualAsset.liquidityTier` is null (the schema's own model comment
 * explains why null means "derive it," not "not yet migrated"). CRYPTO
 * is the one genuinely debatable default — it's a liquid market
 * instrument in principle, but this app's `ManualAsset.CRYPTO` is by
 * definition NOT tracked through the simulated trading desk
 * (`PortfolioHolding`, which is unconditionally SEMI_LIQUID — see
 * `classifyPortfolioHoldingLiquidity` below), so it's more likely a
 * self-custodied or otherwise less-immediately-spendable holding;
 * SEMI_LIQUID is still the more honest default than ILLIQUID for an
 * asset class that trades 24/7 on public markets. PROPERTY/VEHICLE are
 * unambiguous. PENSION/KEREN_HISHTALMUT are illiquid by law (the
 * latter has a real 6-year lock-in, `ManualAsset.liquidityDate`) or by
 * strong social convention (retirement accounts). OTHER defaults
 * conservatively to ILLIQUID — an unclassified asset should never
 * silently inflate a runway calculation.
 */
const MANUAL_ASSET_TYPE_DEFAULT_TIER: Record<string, LiquidityTier> = {
  PROPERTY: "ILLIQUID",
  VEHICLE: "ILLIQUID",
  CRYPTO: "SEMI_LIQUID",
  PENSION: "ILLIQUID",
  KEREN_HISHTALMUT: "ILLIQUID",
  OTHER: "ILLIQUID",
};

/** The tier a `ManualAsset` actually counts as: its explicit `liquidityTier` override if set, otherwise the `assetType`-derived default. */
export function classifyManualAssetLiquidity(assetType: string, liquidityTierOverride: LiquidityTier | null): LiquidityTier {
  if (liquidityTierOverride) return liquidityTierOverride;
  const defaultTier = MANUAL_ASSET_TYPE_DEFAULT_TIER[assetType];
  if (!defaultTier) {
    throw new RangeError(`Unknown ManualAsset assetType: ${assetType}`);
  }
  return defaultTier;
}

/**
 * A checking/savings `BankAccount` is spendable cash — LIQUID by
 * definition. A CREDIT_CARD "account" isn't an asset at all (its
 * balance is a liability, stored positive = money owed — see
 * `computeLiveNetWorth`'s own doc comment) — callers must never pass a
 * credit-card row's balance to this classification at all, which is why
 * this function takes the account type, not a boolean "is this an
 * asset" — it makes the CREDIT_CARD case a loud `RangeError` instead of
 * a silently-wrong LIQUID classification for what is actually debt.
 */
export function classifyBankAccountLiquidity(accountType: string): LiquidityTier {
  if (accountType === "CREDIT_CARD") {
    throw new RangeError("A CREDIT_CARD balance is a liability, not an asset — it has no liquidity tier");
  }
  return "LIQUID";
}

/** Every `PortfolioHolding` (the simulated trading desk — stocks, ETFs, crypto) is SEMI_LIQUID unconditionally: sellable on a public market within days, but subject to price risk, unlike cash. */
export function classifyPortfolioHoldingLiquidity(): LiquidityTier {
  return "SEMI_LIQUID";
}

export type LiquidityBreakdown = {
  liquidAgorot: Agorot;
  semiLiquidAgorot: Agorot;
  illiquidAgorot: Agorot;
};

export type ClassifiableBankAccount = { accountType: string; valueAgorot: Agorot };
export type ClassifiableManualAsset = { assetType: string; liquidityTierOverride: LiquidityTier | null; valueAgorot: Agorot };
export type ClassifiablePortfolioHolding = { valueAgorot: Agorot };

/**
 * Buckets every asset row (bank accounts already filtered to exclude
 * CREDIT_CARD by the caller — see `classifyBankAccountLiquidity`'s doc
 * comment — manual assets, portfolio holdings) into the three-tier
 * liquidity breakdown that `calculateLiquidityRunway` (`liquidity-
 * runway.ts`) consumes.
 */
export function classifyLiquidity(
  bankAccounts: readonly ClassifiableBankAccount[],
  manualAssets: readonly ClassifiableManualAsset[],
  portfolioHoldings: readonly ClassifiablePortfolioHolding[],
): LiquidityBreakdown {
  const liquidAmounts = bankAccounts.map((a) => {
    classifyBankAccountLiquidity(a.accountType); // throws for CREDIT_CARD, per its own doc comment
    return a.valueAgorot;
  });

  const semiLiquidFromManualAssets: Agorot[] = [];
  const illiquidFromManualAssets: Agorot[] = [];
  for (const asset of manualAssets) {
    const tier = classifyManualAssetLiquidity(asset.assetType, asset.liquidityTierOverride);
    if (tier === "LIQUID") {
      // No ManualAsset assetType defaults to LIQUID and this app has no
      // UI path to override one to LIQUID either — a manual asset is by
      // definition off-feed, never instantly spendable cash. Guarded
      // loudly rather than silently miscounting it as liquid.
      throw new RangeError(`ManualAsset classified as LIQUID, which should be impossible: ${asset.assetType}`);
    }
    (tier === "SEMI_LIQUID" ? semiLiquidFromManualAssets : illiquidFromManualAssets).push(asset.valueAgorot);
  }

  const semiLiquidAmounts = [...semiLiquidFromManualAssets, ...portfolioHoldings.map((h) => h.valueAgorot)];

  return {
    liquidAgorot: addAgorot(...liquidAmounts),
    semiLiquidAgorot: addAgorot(...semiLiquidAmounts),
    illiquidAgorot: addAgorot(...illiquidFromManualAssets),
  };
}
