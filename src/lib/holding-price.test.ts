import { describe, expect, it } from "vitest";
import {
  describeHoldingPriceSource,
  resolveHoldingPrice,
  resolveHoldingPrices,
  type LastFillPrice,
  type PricableHolding,
  type QuotePrice,
} from "./holding-price";
import { getMockPriceAgorot, getMockPriceUsdCents } from "./mock-market-data";
import { agorot } from "./money";
import { nativeAmount } from "./currency";
import { convertNativeAmountToAgorot } from "./exchange-rate";

const asOf = new Date("2026-09-18T12:00:00Z");
const RATE = 3.5;
const DAY = 24 * 60 * 60 * 1000;

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

const fillYesterday: LastFillPrice = {
  priceAgorot: agorot(126_788),
  nativePrice: nativeAmount(36_225),
  executedAt: new Date(asOf.getTime() - DAY),
};

describe("resolveHoldingPrice", () => {
  it("prices a seeded instrument from the mock feed, ignoring any evidence", () => {
    const result = resolveHoldingPrice(
      holding({ symbol: "AAPL" }),
      { lastFill: fillYesterday, quote: { priceUsd: 1, observedAt: asOf } },
      asOf,
      RATE,
    );
    expect(result.source).toBe("mock_feed");
    expect(result.observedAt).toBeNull();
    expect(result.priceAgorot).toBe(getMockPriceAgorot("AAPL", asOf, RATE));
    expect(result.nativePrice).toBe(getMockPriceUsdCents("AAPL", asOf));
  });

  it("prices an unknown symbol at a market quote that is newer than the last fill, converting USD at the given rate", () => {
    const quote: QuotePrice = { priceUsd: 370.1, observedAt: asOf };
    const result = resolveHoldingPrice(holding(), { lastFill: fillYesterday, quote }, asOf, RATE);
    expect(result.source).toBe("quote");
    expect(result.observedAt).toBe(asOf);
    expect(result.nativePrice).toBe(nativeAmount(37_010));
    expect(result.priceAgorot).toBe(convertNativeAmountToAgorot(nativeAmount(37_010), "USD", RATE));
  });

  it("prefers the last fill when it is newer than the stored quote — the newest real observation wins", () => {
    const staleQuote: QuotePrice = { priceUsd: 300, observedAt: new Date(asOf.getTime() - 5 * DAY) };
    const result = resolveHoldingPrice(holding(), { lastFill: fillYesterday, quote: staleQuote }, asOf, RATE);
    expect(result).toEqual({
      priceAgorot: fillYesterday.priceAgorot,
      nativePrice: fillYesterday.nativePrice,
      source: "last_fill",
      observedAt: fillYesterday.executedAt,
    });
  });

  it("uses the last fill when there is no quote at all — never throws", () => {
    const result = resolveHoldingPrice(holding(), { lastFill: fillYesterday }, asOf, RATE);
    expect(result.source).toBe("last_fill");
    expect(result.priceAgorot).toBe(agorot(126_788));
  });

  it("falls back to average cost per share with neither a quote nor a fill", () => {
    const result = resolveHoldingPrice(holding({ quantity: 2, totalCostBasis: agorot(701), nativeCostBasis: nativeAmount(201) }), {}, asOf, RATE);
    expect(result.source).toBe("cost_basis");
    expect(result.priceAgorot).toBe(agorot(351)); // 701 / 2 = 350.5 → rounds half up, still an integer
    expect(result.nativePrice).toBe(nativeAmount(101));
    expect(result.observedAt).toBeNull();
  });

  it("values a closed-out (quantity 0) unknown position at 0 rather than dividing by zero", () => {
    const result = resolveHoldingPrice(holding({ quantity: 0 }), {}, asOf, RATE);
    expect(result).toMatchObject({ priceAgorot: agorot(0), nativePrice: nativeAmount(0), source: "cost_basis" });
  });

  it("resolveHoldingPrices keys the batch by symbol and picks the right source per holding", () => {
    const fills = new Map([["TSLA", fillYesterday]]);
    const quotes = new Map<string, QuotePrice>([["NFLX", { priceUsd: 700, observedAt: asOf }]]);
    const prices = resolveHoldingPrices(
      [holding({ symbol: "MSFT" }), holding({ symbol: "TSLA" }), holding({ symbol: "NFLX" }), holding({ symbol: "RIVN" })],
      fills,
      quotes,
      asOf,
      RATE,
    );
    expect(prices.get("MSFT")?.source).toBe("mock_feed");
    expect(prices.get("TSLA")?.source).toBe("last_fill");
    expect(prices.get("NFLX")?.source).toBe("quote");
    expect(prices.get("RIVN")?.source).toBe("cost_basis");
  });
});

describe("describeHoldingPriceSource", () => {
  const base = { priceAgorot: agorot(1), nativePrice: nativeAmount(1) };

  it("says nothing for the mock feed or a same-day quote", () => {
    expect(describeHoldingPriceSource({ ...base, source: "mock_feed", observedAt: null }, asOf)).toBeNull();
    expect(describeHoldingPriceSource({ ...base, source: "quote", observedAt: new Date(asOf.getTime() - 6 * 60 * 60 * 1000) }, asOf)).toBeNull();
  });

  it("dates a quote older than a day, and names a fill or cost-basis valuation", () => {
    expect(describeHoldingPriceSource({ ...base, source: "quote", observedAt: new Date(asOf.getTime() - 3 * DAY) }, asOf)).toBe("quote from 2026-09-15");
    expect(describeHoldingPriceSource({ ...base, source: "last_fill", observedAt: fillYesterday.executedAt }, asOf)).toBe("valued at last fill");
    expect(describeHoldingPriceSource({ ...base, source: "cost_basis", observedAt: null }, asOf)).toBe("valued at cost");
  });
});
