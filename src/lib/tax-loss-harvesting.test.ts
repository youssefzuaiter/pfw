import { describe, expect, it } from "vitest";
import { agorot } from "./money";
import { nativeAmount } from "./currency";
import { findHarvestCandidates, summarizeHarvestPotential, WASH_SALE_WINDOW_DAYS } from "./tax-loss-harvesting";
import type { OpenTaxLot } from "./tax-lots";

const ASOF = new Date("2024-06-01T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function lot(symbol: string, acquiredAt: Date, quantity: number, costBasisAgorot: number): OpenTaxLot {
  return {
    symbol,
    currency: "USD",
    acquiredAt,
    quantity,
    costBasisAgorot: agorot(costBasisAgorot),
    nativeCostBasis: nativeAmount(costBasisAgorot),
  };
}

describe("findHarvestCandidates()", () => {
  it("excludes lots currently at a gain", () => {
    const lots = [lot("AAPL", new Date("2023-01-01"), 10, 100_000)];
    const prices = new Map([["AAPL", agorot(12_000)]]); // 10 sh @ ₪120 = ₪1,200 > cost basis ₪1,000
    const candidates = findHarvestCandidates(lots, prices, new Map(), 0.2, ASOF);
    expect(candidates).toHaveLength(0);
  });

  it("surfaces a lot currently at a loss with the loss magnitude and an estimated savings figure", () => {
    const lots = [lot("AAPL", new Date("2023-01-01"), 10, 100_000)];
    const prices = new Map([["AAPL", agorot(8_000)]]); // 10 sh @ ₪80 = ₪800 < cost basis ₪1,000
    const [candidate] = findHarvestCandidates(lots, prices, new Map(), 0.2, ASOF);
    expect(candidate.unrealizedLossAgorot).toBe(-20_000);
    expect(candidate.estimatedTaxSavingsAgorot).toBe(4_000); // 20,000 * 0.2
  });

  it("skips a symbol with no current price available", () => {
    const lots = [lot("AAPL", new Date("2023-01-01"), 10, 100_000)];
    const candidates = findHarvestCandidates(lots, new Map(), new Map(), 0.2, ASOF);
    expect(candidates).toHaveLength(0);
  });

  it("sorts candidates biggest loss first", () => {
    const lots = [
      lot("AAPL", new Date("2023-01-01"), 10, 100_000), // loss -20,000
      lot("MSFT", new Date("2023-01-01"), 10, 200_000), // loss -50,000
    ];
    const prices = new Map([
      ["AAPL", agorot(8_000)],
      ["MSFT", agorot(15_000)],
    ]);
    const candidates = findHarvestCandidates(lots, prices, new Map(), 0.2, ASOF);
    expect(candidates.map((c) => c.symbol)).toEqual(["MSFT", "AAPL"]);
  });

  it("flags a wash-sale risk when a BUY of the same symbol happened within the last 30 days", () => {
    const lots = [lot("AAPL", new Date("2023-01-01"), 10, 100_000)];
    const prices = new Map([["AAPL", agorot(8_000)]]);
    const recentBuy = new Date(ASOF.getTime() - (WASH_SALE_WINDOW_DAYS - 5) * DAY_MS);
    const recentBuys = new Map([["AAPL", [recentBuy]]]);
    const [candidate] = findHarvestCandidates(lots, prices, recentBuys, 0.2, ASOF);
    expect(candidate.washSaleRisk).toBe(true);
  });

  it("does not flag a wash-sale risk for a purchase well outside the window", () => {
    const lots = [lot("AAPL", new Date("2023-01-01"), 10, 100_000)];
    const prices = new Map([["AAPL", agorot(8_000)]]);
    const oldBuy = new Date(ASOF.getTime() - (WASH_SALE_WINDOW_DAYS + 5) * DAY_MS);
    const recentBuys = new Map([["AAPL", [oldBuy]]]);
    const [candidate] = findHarvestCandidates(lots, prices, recentBuys, 0.2, ASOF);
    expect(candidate.washSaleRisk).toBe(false);
  });

  it("clamps a negative estimated marginal rate to zero savings rather than a negative figure", () => {
    const lots = [lot("AAPL", new Date("2023-01-01"), 10, 100_000)];
    const prices = new Map([["AAPL", agorot(8_000)]]);
    const [candidate] = findHarvestCandidates(lots, prices, new Map(), -0.5, ASOF);
    expect(candidate.estimatedTaxSavingsAgorot).toBe(0);
  });
});

describe("summarizeHarvestPotential()", () => {
  it("sums losses and estimated savings and counts wash-sale-flagged candidates", () => {
    const lots = [
      lot("AAPL", new Date("2023-01-01"), 10, 100_000),
      lot("MSFT", new Date("2023-01-01"), 10, 200_000),
    ];
    const prices = new Map([
      ["AAPL", agorot(8_000)], // loss -20,000
      ["MSFT", agorot(15_000)], // loss -50,000
    ]);
    const recentBuys = new Map([["AAPL", [new Date(ASOF.getTime() - 1 * DAY_MS)]]]);
    const candidates = findHarvestCandidates(lots, prices, recentBuys, 0.2, ASOF);
    const summary = summarizeHarvestPotential(candidates);

    expect(summary.totalHarvestableLossAgorot).toBe(-70_000);
    expect(summary.totalEstimatedTaxSavingsAgorot).toBe(14_000);
    expect(summary.washSaleFlaggedCount).toBe(1);
  });

  it("returns zeroed totals for an empty candidate list", () => {
    expect(summarizeHarvestPotential([])).toEqual({
      totalHarvestableLossAgorot: 0,
      totalEstimatedTaxSavingsAgorot: 0,
      washSaleFlaggedCount: 0,
    });
  });
});
