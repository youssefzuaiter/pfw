import { describe, expect, it } from "vitest";
import { agorot } from "./money";
import { nativeAmount } from "./currency";
import { applyBuy, applySell, unrealizedPnl, type HoldingPosition } from "./portfolio-math";

/** All native amounts are USD cents (integers) — e.g. 2700 = $27.00. */
function position(quantity: number, totalCostBasis: number, nativeCostBasis: number): HoldingPosition {
  return {
    quantity,
    currency: "USD",
    totalCostBasis: agorot(totalCostBasis),
    nativeCostBasis: nativeAmount(nativeCostBasis),
  };
}

describe("applyBuy()", () => {
  it("adds shares and cost to an existing position, native and base in lockstep", () => {
    const result = applyBuy(position(10, 1_000, 2_700), 5, agorot(600), nativeAmount(1_620));
    expect(result).toEqual(position(15, 1_600, 4_320));
  });

  it("rejects a non-positive quantity", () => {
    expect(() => applyBuy(position(0, 0, 0), 0, agorot(100), nativeAmount(27))).toThrow(RangeError);
    expect(() => applyBuy(position(0, 0, 0), -1, agorot(100), nativeAmount(27))).toThrow(RangeError);
  });
});

describe("applySell()", () => {
  it("realizes gain proportional to the weighted-average cost per share, in both currencies", () => {
    // 10 shares @ avg cost 100 agorot ($27.00 native total, $2.70/share). Sell 4 @ 150 agorot / 405 cents per share.
    const result = applySell(position(10, 1_000, 2_700), 4, agorot(150), nativeAmount(405));
    expect(result.proceeds).toBe(600);
    expect(result.realizedPnl).toBe(200); // 600 proceeds - 400 cost basis sold
    expect(result.nativeProceeds).toBe(1_620); // 4 * 405
    expect(result.nativeRealizedPnl).toBe(540); // 1620 proceeds - 1080 native cost basis sold
    expect(result.position).toEqual(position(6, 600, 1_620));
  });

  it("realizes a loss when selling below average cost", () => {
    const result = applySell(position(10, 1_000, 2_700), 4, agorot(50), nativeAmount(130));
    expect(result.realizedPnl).toBe(-200); // 200 proceeds - 400 cost basis sold
    expect(result.nativeRealizedPnl).toBe(-560); // 520 proceeds - 1080 native cost basis sold
  });

  it("leaves exactly zero cost basis on a full liquidation (no rounding dust)", () => {
    const result = applySell(position(3, 1_000, 2_700), 3, agorot(400), nativeAmount(1_080));
    expect(result.position).toEqual(position(0, 0, 0));
  });

  it("rejects selling more shares than are held", () => {
    expect(() => applySell(position(5, 500, 1_350), 6, agorot(100), nativeAmount(270))).toThrow(RangeError);
  });

  it("rejects a non-positive quantity", () => {
    expect(() => applySell(position(5, 500, 1_350), 0, agorot(100), nativeAmount(270))).toThrow(RangeError);
  });
});

describe("unrealizedPnl()", () => {
  it("is positive when the current price exceeds average cost, in both currencies", () => {
    const result = unrealizedPnl(position(10, 1_000, 2_700), agorot(150), nativeAmount(405));
    expect(result.pnl).toBe(500);
    expect(result.nativePnl).toBe(1_350); // 4050 current value - 2700 native cost basis
  });

  it("is negative when the current price is below average cost", () => {
    const result = unrealizedPnl(position(10, 1_000, 2_700), agorot(50), nativeAmount(130));
    expect(result.pnl).toBe(-500);
    expect(result.nativePnl).toBe(-1_400); // 1300 current value - 2700 native cost basis
  });

  it("is zero when the current price equals average cost", () => {
    const result = unrealizedPnl(position(10, 1_000, 2_700), agorot(100), nativeAmount(270));
    expect(result.pnl).toBe(0);
    expect(result.nativePnl).toBe(0);
  });
});
