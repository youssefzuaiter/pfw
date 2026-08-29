import { describe, expect, it } from "vitest";
import { agorot } from "./money";
import { nativeAmount, type CurrencyCode } from "./currency";
import {
  buildUpcomingPayouts,
  computeTrailingYield,
  sumDividendIncome,
  sumProjectedNative,
  summarizeAllocation,
  summarizePortfolioReturn,
  summarizePosition,
  type AnalyticsPosition,
  type AnnouncedDividend,
  type AssetClass,
  type PaidDividend,
} from "./portfolio-analytics";

const RATES: Readonly<Record<CurrencyCode, number>> = { ILS: 1, USD: 4, EUR: 4, GBP: 5 };

function position(overrides: Partial<AnalyticsPosition> = {}): AnalyticsPosition {
  return {
    symbol: "AAPL",
    assetClass: "STOCK",
    currency: "USD",
    quantity: 10,
    totalCostBasis: agorot(100_000),
    nativeCostBasis: nativeAmount(25_000),
    currentPrice: agorot(12_000),
    nativeCurrentPrice: nativeAmount(3_000),
    ...overrides,
  };
}

describe("summarizePosition()", () => {
  it("computes market value and unrealized gain in both currencies", () => {
    const result = summarizePosition(position());
    expect(result.marketValue).toBe(120_000); // 10 * 12000
    expect(result.nativeMarketValue).toBe(30_000); // 10 * 3000
    expect(result.unrealizedGain).toBe(20_000);
    expect(result.nativeUnrealizedGain).toBe(5_000);
    expect(result.unrealizedReturnRate).toBeCloseTo(0.2);
  });

  it("reports a loss as a negative gain and negative rate", () => {
    const result = summarizePosition(position({ currentPrice: agorot(8_000), nativeCurrentPrice: nativeAmount(2_000) }));
    expect(result.unrealizedGain).toBe(-20_000);
    expect(result.unrealizedReturnRate).toBeCloseTo(-0.2);
  });

  it("returns null (not 0) for the return rate on a zero cost basis", () => {
    const result = summarizePosition(position({ totalCostBasis: agorot(0), nativeCostBasis: nativeAmount(0) }));
    expect(result.unrealizedReturnRate).toBeNull();
    expect(result.unrealizedGain).toBe(120_000);
  });

  it("handles a fully-liquidated position (quantity 0)", () => {
    const result = summarizePosition(
      position({ quantity: 0, totalCostBasis: agorot(0), nativeCostBasis: nativeAmount(0) }),
    );
    expect(result.marketValue).toBe(0);
    expect(result.unrealizedGain).toBe(0);
    expect(result.unrealizedReturnRate).toBeNull();
  });

  it("handles fractional quantities without producing a fractional agorot", () => {
    const result = summarizePosition(position({ quantity: 0.5 }));
    expect(Number.isInteger(result.marketValue)).toBe(true);
    expect(Number.isInteger(result.nativeMarketValue)).toBe(true);
    expect(result.marketValue).toBe(6_000);
  });
});

describe("summarizeAllocation()", () => {
  it("groups market value by asset class and computes shares summing to 1", () => {
    const positions = [
      summarizePosition(position({ symbol: "AAPL", assetClass: "STOCK" })), // 120000
      summarizePosition(position({ symbol: "SPY", assetClass: "ETF" })), // 120000
      summarizePosition(position({ symbol: "BTC", assetClass: "CRYPTO", quantity: 20 })), // 240000
    ];
    const allocation = summarizeAllocation(positions);

    expect(allocation).toHaveLength(3);
    expect(allocation.reduce((sum, slice) => sum + slice.share, 0)).toBeCloseTo(1);
    // Sorted by value descending — crypto is the largest here.
    expect(allocation[0].assetClass).toBe("CRYPTO");
    expect(allocation[0].share).toBeCloseTo(0.5);
  });

  it("merges multiple positions of the same asset class into one slice", () => {
    const positions = [
      summarizePosition(position({ symbol: "AAPL", assetClass: "STOCK" })),
      summarizePosition(position({ symbol: "MSFT", assetClass: "STOCK" })),
    ];
    const allocation = summarizeAllocation(positions);
    expect(allocation).toHaveLength(1);
    expect(allocation[0].marketValue).toBe(240_000);
    expect(allocation[0].share).toBeCloseTo(1);
  });

  it("omits asset classes that are not held rather than listing them at zero", () => {
    const allocation = summarizeAllocation([summarizePosition(position({ assetClass: "ETF" }))]);
    expect(allocation.map((s) => s.assetClass)).toEqual(["ETF"]);
  });

  it("returns an empty allocation for an empty portfolio", () => {
    expect(summarizeAllocation([])).toEqual([]);
  });

  it("gives every slice a share of 0 when total market value is zero, instead of dividing by zero", () => {
    const positions = [summarizePosition(position({ quantity: 0, totalCostBasis: agorot(0), nativeCostBasis: nativeAmount(0) }))];
    const allocation = summarizeAllocation(positions);
    expect(allocation[0].share).toBe(0);
    expect(Number.isNaN(allocation[0].share)).toBe(false);
  });
});

describe("summarizePortfolioReturn()", () => {
  it("combines unrealized, realized, and dividend income into total gain", () => {
    const positions = [summarizePosition(position())]; // cost 100000, value 120000
    const result = summarizePortfolioReturn(positions, agorot(5_000), agorot(3_000));

    expect(result.totalCostBasis).toBe(100_000);
    expect(result.totalMarketValue).toBe(120_000);
    expect(result.unrealizedGain).toBe(20_000);
    expect(result.realizedGain).toBe(5_000);
    expect(result.dividendIncome).toBe(3_000);
    expect(result.totalGain).toBe(28_000);
    expect(result.totalReturnRate).toBeCloseTo(0.28);
  });

  it("counts dividend income that price appreciation alone would miss", () => {
    // A flat position that has still returned something via dividends.
    const flat = [summarizePosition(position({ currentPrice: agorot(10_000), nativeCurrentPrice: nativeAmount(2_500) }))];
    const result = summarizePortfolioReturn(flat, agorot(0), agorot(4_000));
    expect(result.unrealizedGain).toBe(0);
    expect(result.totalGain).toBe(4_000);
    expect(result.totalReturnRate).toBeCloseTo(0.04);
  });

  it("nets a realized loss against gains", () => {
    const positions = [summarizePosition(position())];
    const result = summarizePortfolioReturn(positions, agorot(-30_000), agorot(0));
    expect(result.totalGain).toBe(-10_000);
    expect(result.totalReturnRate).toBeCloseTo(-0.1);
  });

  it("returns null for the rate on an empty portfolio rather than NaN", () => {
    const result = summarizePortfolioReturn([], agorot(0), agorot(0));
    expect(result.totalReturnRate).toBeNull();
    expect(result.totalGain).toBe(0);
  });
});

describe("buildUpcomingPayouts()", () => {
  const asOf = new Date("2026-08-28T00:00:00Z");

  function announced(overrides: Partial<AnnouncedDividend> = {}): AnnouncedDividend {
    return {
      symbol: "AAPL",
      currency: "USD",
      amountPerShareNative: nativeAmount(25),
      exDate: new Date("2026-09-01T00:00:00Z"),
      payDate: new Date("2026-09-22T00:00:00Z"),
      ...overrides,
    };
  }

  it("projects the payout from current quantity and converts to agorot", () => {
    const payouts = buildUpcomingPayouts([announced()], [position()], RATES, asOf);
    expect(payouts).toHaveLength(1);
    expect(payouts[0].projectedNativeAmount).toBe(250); // 25 cents * 10 shares
    expect(payouts[0].projectedAgorot).toBe(1_000); // 250 * rate 4
  });

  it("excludes dividends whose pay date has already passed", () => {
    const past = announced({ payDate: new Date("2026-08-01T00:00:00Z") });
    expect(buildUpcomingPayouts([past], [position()], RATES, asOf)).toEqual([]);
  });

  it("excludes a symbol the user no longer holds", () => {
    const payouts = buildUpcomingPayouts([announced({ symbol: "MSFT" })], [position({ symbol: "AAPL" })], RATES, asOf);
    expect(payouts).toEqual([]);
  });

  it("excludes a fully-liquidated position rather than projecting a zero payout for it", () => {
    const payouts = buildUpcomingPayouts([announced()], [position({ quantity: 0 })], RATES, asOf);
    expect(payouts).toEqual([]);
  });

  it("sorts by pay date, soonest first", () => {
    const later = announced({ symbol: "MSFT", payDate: new Date("2026-10-15T00:00:00Z"), exDate: new Date("2026-09-24T00:00:00Z") });
    const sooner = announced({ symbol: "SPY", payDate: new Date("2026-09-05T00:00:00Z"), exDate: new Date("2026-08-30T00:00:00Z") });
    const positions = [position({ symbol: "MSFT" }), position({ symbol: "SPY" })];

    const payouts = buildUpcomingPayouts([later, sooner], positions, RATES, asOf);
    expect(payouts.map((p) => p.symbol)).toEqual(["SPY", "MSFT"]);
  });

  it("does not apply a rate to an ILS-denominated dividend", () => {
    const ilsDividend = announced({ currency: "ILS", amountPerShareNative: nativeAmount(100) });
    const payouts = buildUpcomingPayouts([ilsDividend], [position({ currency: "ILS" })], RATES, asOf);
    expect(payouts[0].projectedAgorot).toBe(1_000); // 100 * 10 shares, no conversion
  });

  it("handles an empty announced list", () => {
    expect(buildUpcomingPayouts([], [position()], RATES, asOf)).toEqual([]);
  });
});

describe("computeTrailingYield()", () => {
  const asOf = new Date("2026-08-28T00:00:00Z");

  function paid(symbol: string, totalAgorot: number, payDate: string): PaidDividend {
    return { symbol, totalAgorot: agorot(totalAgorot), payDate: new Date(payDate) };
  }

  it("sums the last 12 months of paid dividends over market value", () => {
    const summary = summarizePosition(position()); // market value 120000
    const dividends = [
      paid("AAPL", 1_200, "2026-06-01T00:00:00Z"),
      paid("AAPL", 1_200, "2026-03-01T00:00:00Z"),
    ];
    expect(computeTrailingYield(summary, dividends, asOf)).toBeCloseTo(2_400 / 120_000);
  });

  it("excludes dividends older than 12 months", () => {
    const summary = summarizePosition(position());
    const dividends = [paid("AAPL", 1_200, "2025-01-01T00:00:00Z")];
    expect(computeTrailingYield(summary, dividends, asOf)).toBe(0);
  });

  it("excludes dividends belonging to a different symbol", () => {
    const summary = summarizePosition(position({ symbol: "AAPL" }));
    const dividends = [paid("MSFT", 5_000, "2026-06-01T00:00:00Z")];
    expect(computeTrailingYield(summary, dividends, asOf)).toBe(0);
  });

  it("returns 0 for a dividend-paying-nothing position, which is a real zero", () => {
    const summary = summarizePosition(position({ symbol: "BTC", assetClass: "CRYPTO" }));
    expect(computeTrailingYield(summary, [], asOf)).toBe(0);
  });

  it("returns null (not Infinity) when market value is zero", () => {
    const summary = summarizePosition(position({ quantity: 0, totalCostBasis: agorot(0), nativeCostBasis: nativeAmount(0) }));
    expect(computeTrailingYield(summary, [paid("AAPL", 1_000, "2026-06-01T00:00:00Z")], asOf)).toBeNull();
  });
});

describe("sumDividendIncome()", () => {
  const dividends: PaidDividend[] = [
    { symbol: "AAPL", totalAgorot: agorot(1_000), payDate: new Date("2026-01-15T00:00:00Z") },
    { symbol: "MSFT", totalAgorot: agorot(2_000), payDate: new Date("2026-06-15T00:00:00Z") },
  ];

  it("sums everything when no window is given", () => {
    expect(sumDividendIncome(dividends)).toBe(3_000);
  });

  it("respects a since bound", () => {
    expect(sumDividendIncome(dividends, new Date("2026-03-01T00:00:00Z"))).toBe(2_000);
  });

  it("respects an until bound", () => {
    expect(sumDividendIncome(dividends, undefined, new Date("2026-03-01T00:00:00Z"))).toBe(1_000);
  });

  it("returns zero for an empty list", () => {
    expect(sumDividendIncome([])).toBe(0);
  });
});

describe("sumProjectedNative()", () => {
  const asOf = new Date("2026-08-28T00:00:00Z");

  it("subtotals only the requested currency", () => {
    const usd: AnnouncedDividend = {
      symbol: "AAPL",
      currency: "USD",
      amountPerShareNative: nativeAmount(25),
      exDate: new Date("2026-09-01T00:00:00Z"),
      payDate: new Date("2026-09-22T00:00:00Z"),
    };
    const payouts = buildUpcomingPayouts([usd], [position()], RATES, asOf);

    expect(sumProjectedNative(payouts, "USD")).toBe(250);
    expect(sumProjectedNative(payouts, "EUR")).toBe(0);
  });
});

describe("asset class typing", () => {
  it("accepts each of the three asset classes", () => {
    const classes: AssetClass[] = ["STOCK", "ETF", "CRYPTO"];
    for (const assetClass of classes) {
      expect(summarizePosition(position({ assetClass })).assetClass).toBe(assetClass);
    }
  });
});
