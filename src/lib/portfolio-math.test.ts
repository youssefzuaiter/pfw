import { describe, expect, it } from "vitest";
import { agorot } from "./money";
import { applyBuy, applySell, unrealizedPnl } from "./portfolio-math";

describe("applyBuy()", () => {
  it("adds shares and cost to an existing position", () => {
    const result = applyBuy({ quantity: 10, totalCostBasis: agorot(1_000) }, 5, agorot(600));
    expect(result).toEqual({ quantity: 15, totalCostBasis: 1_600 });
  });

  it("rejects a non-positive quantity", () => {
    expect(() => applyBuy({ quantity: 0, totalCostBasis: agorot(0) }, 0, agorot(100))).toThrow(RangeError);
    expect(() => applyBuy({ quantity: 0, totalCostBasis: agorot(0) }, -1, agorot(100))).toThrow(RangeError);
  });
});

describe("applySell()", () => {
  it("realizes gain proportional to the weighted-average cost per share", () => {
    // 10 shares @ avg cost 100 agorot/share (total 1,000). Sell 4 @ 150/share.
    const result = applySell({ quantity: 10, totalCostBasis: agorot(1_000) }, 4, agorot(150));
    expect(result.proceeds).toBe(600);
    expect(result.realizedPnl).toBe(200); // 600 proceeds - 400 cost basis sold
    expect(result.position).toEqual({ quantity: 6, totalCostBasis: 600 });
  });

  it("realizes a loss when selling below average cost", () => {
    const result = applySell({ quantity: 10, totalCostBasis: agorot(1_000) }, 4, agorot(50));
    expect(result.realizedPnl).toBe(-200); // 200 proceeds - 400 cost basis sold
  });

  it("leaves exactly zero cost basis on a full liquidation (no rounding dust)", () => {
    const result = applySell({ quantity: 3, totalCostBasis: agorot(1_000) }, 3, agorot(400));
    expect(result.position).toEqual({ quantity: 0, totalCostBasis: 0 });
  });

  it("rejects selling more shares than are held", () => {
    expect(() => applySell({ quantity: 5, totalCostBasis: agorot(500) }, 6, agorot(100))).toThrow(RangeError);
  });

  it("rejects a non-positive quantity", () => {
    expect(() => applySell({ quantity: 5, totalCostBasis: agorot(500) }, 0, agorot(100))).toThrow(RangeError);
  });
});

describe("unrealizedPnl()", () => {
  it("is positive when the current price exceeds average cost", () => {
    expect(unrealizedPnl({ quantity: 10, totalCostBasis: agorot(1_000) }, agorot(150))).toBe(500);
  });

  it("is negative when the current price is below average cost", () => {
    expect(unrealizedPnl({ quantity: 10, totalCostBasis: agorot(1_000) }, agorot(50))).toBe(-500);
  });

  it("is zero when the current price equals average cost", () => {
    expect(unrealizedPnl({ quantity: 10, totalCostBasis: agorot(1_000) }, agorot(100))).toBe(0);
  });
});
