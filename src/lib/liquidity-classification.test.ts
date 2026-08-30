import { describe, expect, it } from "vitest";
import { agorot } from "./money";
import {
  classifyBankAccountLiquidity,
  classifyLiquidity,
  classifyManualAssetLiquidity,
  classifyPortfolioHoldingLiquidity,
} from "./liquidity-classification";

describe("classifyManualAssetLiquidity", () => {
  it.each([
    ["PROPERTY", "ILLIQUID"],
    ["VEHICLE", "ILLIQUID"],
    ["CRYPTO", "SEMI_LIQUID"],
    ["PENSION", "ILLIQUID"],
    ["KEREN_HISHTALMUT", "ILLIQUID"],
    ["OTHER", "ILLIQUID"],
  ] as const)("defaults %s to %s when no override is set", (assetType, expected) => {
    expect(classifyManualAssetLiquidity(assetType, null)).toBe(expected);
  });

  it("an explicit override wins over the assetType default", () => {
    expect(classifyManualAssetLiquidity("PROPERTY", "SEMI_LIQUID")).toBe("SEMI_LIQUID");
    expect(classifyManualAssetLiquidity("CRYPTO", "ILLIQUID")).toBe("ILLIQUID");
  });

  it("throws for an unrecognized assetType rather than silently defaulting", () => {
    expect(() => classifyManualAssetLiquidity("NOT_A_REAL_TYPE", null)).toThrow(RangeError);
  });
});

describe("classifyBankAccountLiquidity", () => {
  it.each(["CHECKING", "SAVINGS"])("%s is LIQUID", (accountType) => {
    expect(classifyBankAccountLiquidity(accountType)).toBe("LIQUID");
  });

  it("throws for CREDIT_CARD — a balance owed is a liability, not an asset with a liquidity tier", () => {
    expect(() => classifyBankAccountLiquidity("CREDIT_CARD")).toThrow(RangeError);
  });
});

describe("classifyPortfolioHoldingLiquidity", () => {
  it("is always SEMI_LIQUID", () => {
    expect(classifyPortfolioHoldingLiquidity()).toBe("SEMI_LIQUID");
  });
});

describe("classifyLiquidity", () => {
  it("buckets a realistic mixed portfolio correctly", () => {
    const result = classifyLiquidity(
      [
        { accountType: "CHECKING", valueAgorot: agorot(500_000) },
        { accountType: "SAVINGS", valueAgorot: agorot(1_000_000) },
      ],
      [
        { assetType: "PROPERTY", liquidityTierOverride: null, valueAgorot: agorot(80_000_000) },
        { assetType: "CRYPTO", liquidityTierOverride: null, valueAgorot: agorot(300_000) },
        { assetType: "OTHER", liquidityTierOverride: "SEMI_LIQUID", valueAgorot: agorot(50_000) }, // overridden
      ],
      [{ valueAgorot: agorot(2_000_000) }],
    );

    expect(result.liquidAgorot).toBe(1_500_000);
    expect(result.semiLiquidAgorot).toBe(300_000 + 50_000 + 2_000_000);
    expect(result.illiquidAgorot).toBe(80_000_000);
  });

  it("all-empty inputs produce all-zero buckets, not an error", () => {
    const result = classifyLiquidity([], [], []);
    expect(result).toEqual({ liquidAgorot: 0, semiLiquidAgorot: 0, illiquidAgorot: 0 });
  });

  it("propagates the CREDIT_CARD guard — a caller that forgot to filter credit cards out gets a loud error, not a silently-wrong liquid total", () => {
    expect(() => classifyLiquidity([{ accountType: "CREDIT_CARD", valueAgorot: agorot(10_000) }], [], [])).toThrow(
      RangeError,
    );
  });

  it("portfolio holdings alone (no bank accounts or manual assets) still classify correctly", () => {
    const result = classifyLiquidity([], [], [{ valueAgorot: agorot(75_000) }, { valueAgorot: agorot(25_000) }]);
    expect(result).toEqual({ liquidAgorot: 0, semiLiquidAgorot: 100_000, illiquidAgorot: 0 });
  });
});
