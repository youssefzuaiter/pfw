import { describe, expect, it } from "vitest";
import { resolveHoldingPrice, resolveHoldingPrices, type PricableHolding } from "./holding-price";
import { getMockPriceAgorot, getMockPriceUsdCents } from "./mock-market-data";
import { agorot } from "./money";
import { nativeAmount } from "./currency";

const asOf = new Date("2026-09-18T12:00:00Z");
const RATE = 3.5;

function holding(overrides: Partial<PricableHolding> = {}): PricableHolding {
  return {
    symbol: "TSLA",
    quantity: 0.174192544,
    // 0.174192544 sh × $362.25 ≈ $63.10 → cost basis in cents / agorot
    totalCostBasis: agorot(22_085),
    nativeCostBasis: nativeAmount(6_310),
    ...overrides,
  };
}

describe("resolveHoldingPrice", () => {
  it("prices a seeded instrument from the mock feed, ignoring any fill", () => {
    const result = resolveHoldingPrice(
      holding({ symbol: "AAPL" }),
      { priceAgorot: agorot(1), nativePrice: nativeAmount(1) },
      asOf,
      RATE,
    );
    expect(result.source).toBe("mock_feed");
    expect(result.priceAgorot).toBe(getMockPriceAgorot("AAPL", asOf, RATE));
    expect(result.nativePrice).toBe(getMockPriceUsdCents("AAPL", asOf));
  });

  it("prices a symbol the mock feed doesn't know at its last fill — never throws", () => {
    const lastFill = { priceAgorot: agorot(126_788), nativePrice: nativeAmount(36_225) };
    const result = resolveHoldingPrice(holding(), lastFill, asOf, RATE);
    expect(result).toEqual({ ...lastFill, source: "last_fill" });
  });

  it("falls back to average cost per share when there is no fill on record", () => {
    const result = resolveHoldingPrice(holding({ quantity: 2, totalCostBasis: agorot(701), nativeCostBasis: nativeAmount(201) }), undefined, asOf, RATE);
    expect(result.source).toBe("cost_basis");
    expect(result.priceAgorot).toBe(agorot(351)); // 701 / 2 = 350.5 → rounds half up, still an integer
    expect(result.nativePrice).toBe(nativeAmount(101));
  });

  it("values a closed-out (quantity 0) unknown position at 0 rather than dividing by zero", () => {
    const result = resolveHoldingPrice(holding({ quantity: 0 }), undefined, asOf, RATE);
    expect(result).toEqual({ priceAgorot: agorot(0), nativePrice: nativeAmount(0), source: "cost_basis" });
  });

  it("resolveHoldingPrices keys the batch by symbol and picks the right source per holding", () => {
    const fills = new Map([["TSLA", { priceAgorot: agorot(100), nativePrice: nativeAmount(30) }]]);
    const prices = resolveHoldingPrices(
      [holding({ symbol: "MSFT" }), holding({ symbol: "TSLA" }), holding({ symbol: "NFLX" })],
      fills,
      asOf,
      RATE,
    );
    expect(prices.get("MSFT")?.source).toBe("mock_feed");
    expect(prices.get("TSLA")).toEqual({ priceAgorot: agorot(100), nativePrice: nativeAmount(30), source: "last_fill" });
    expect(prices.get("NFLX")?.source).toBe("cost_basis");
  });
});
