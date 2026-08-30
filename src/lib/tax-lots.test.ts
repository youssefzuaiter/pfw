import { describe, expect, it } from "vitest";
import { agorot } from "./money";
import { nativeAmount } from "./currency";
import { holdingPeriodDays, replayTaxLots, type LotTradeEvent } from "./tax-lots";

const DAY_MS = 24 * 60 * 60 * 1000;
const d = (isoDate: string) => new Date(isoDate);

function buy(executedAt: string, quantity: number, priceAgorot: number, nativePricePerShare: number): LotTradeEvent {
  return { side: "BUY", quantity, executedAt: d(executedAt), priceAgorot: agorot(priceAgorot), nativePricePerShare: nativeAmount(nativePricePerShare) };
}

function sell(executedAt: string, quantity: number, priceAgorot: number, nativePricePerShare: number): LotTradeEvent {
  return { side: "SELL", quantity, executedAt: d(executedAt), priceAgorot: agorot(priceAgorot), nativePricePerShare: nativeAmount(nativePricePerShare) };
}

describe("holdingPeriodDays()", () => {
  it("rounds the elapsed days between acquisition and disposal", () => {
    expect(holdingPeriodDays(d("2024-01-01"), d("2024-01-01"))).toBe(0);
    expect(holdingPeriodDays(d("2024-01-01"), new Date(d("2024-01-01").getTime() + 400 * DAY_MS))).toBe(400);
  });
});

describe("replayTaxLots() — FIFO", () => {
  it("matches a sell against the oldest open lot first", () => {
    const trades = [
      buy("2023-01-01", 10, 10_000, 270_000), // 10 sh @ ₪100.00
      buy("2023-06-01", 10, 15_000, 405_000), // 10 sh @ ₪150.00
      sell("2024-02-01", 12, 20_000, 540_000), // sell 12 @ ₪200.00 — 10 from lot 1, 2 from lot 2
    ];

    const { openLots, disposals } = replayTaxLots("AAPL", "USD", trades, "FIFO");

    expect(disposals).toHaveLength(2);
    expect(disposals[0]).toMatchObject({ quantity: 10, costBasisAgorot: 100_000, proceedsAgorot: 200_000, realizedGainAgorot: 100_000 });
    expect(disposals[0].acquiredAt).toEqual(d("2023-01-01"));
    expect(disposals[1]).toMatchObject({ quantity: 2, costBasisAgorot: 30_000, proceedsAgorot: 40_000, realizedGainAgorot: 10_000 });
    expect(disposals[1].acquiredAt).toEqual(d("2023-06-01"));

    expect(openLots).toHaveLength(1);
    expect(openLots[0]).toMatchObject({ quantity: 8, costBasisAgorot: 120_000, acquiredAt: d("2023-06-01") });
  });

  it("computes holding period in days from the matched lot's acquisition date", () => {
    const trades = [buy("2023-01-01", 5, 10_000, 270_000), sell("2024-01-01", 5, 12_000, 324_000)];
    const { disposals } = replayTaxLots("AAPL", "USD", trades, "FIFO");
    expect(disposals[0].holdingPeriodDays).toBe(365);
  });
});

describe("replayTaxLots() — LIFO", () => {
  it("matches a sell against the newest open lot first", () => {
    const trades = [
      buy("2023-01-01", 10, 10_000, 270_000),
      buy("2023-06-01", 10, 15_000, 405_000),
      sell("2024-02-01", 12, 20_000, 540_000), // sell 12 @ ₪200.00 — 10 from lot 2 (newest), 2 from lot 1
    ];

    const { openLots, disposals } = replayTaxLots("AAPL", "USD", trades, "LIFO");

    expect(disposals).toHaveLength(2);
    expect(disposals[0]).toMatchObject({ quantity: 10, costBasisAgorot: 150_000, realizedGainAgorot: 50_000 });
    expect(disposals[0].acquiredAt).toEqual(d("2023-06-01"));
    expect(disposals[1]).toMatchObject({ quantity: 2, costBasisAgorot: 20_000, realizedGainAgorot: 20_000 });
    expect(disposals[1].acquiredAt).toEqual(d("2023-01-01"));

    expect(openLots).toHaveLength(1);
    expect(openLots[0]).toMatchObject({ quantity: 8, costBasisAgorot: 80_000, acquiredAt: d("2023-01-01") });
  });

  it("gives a different realized gain than FIFO for the same trade history", () => {
    const trades = [
      buy("2023-01-01", 10, 10_000, 270_000),
      buy("2023-06-01", 10, 15_000, 405_000),
      sell("2024-02-01", 10, 20_000, 540_000),
    ];

    const fifo = replayTaxLots("AAPL", "USD", trades, "FIFO");
    const lifo = replayTaxLots("AAPL", "USD", trades, "LIFO");

    expect(fifo.disposals[0].realizedGainAgorot).toBe(100_000); // sold the ₪100 lot
    expect(lifo.disposals[0].realizedGainAgorot).toBe(50_000); // sold the ₪150 lot
  });
});

describe("replayTaxLots() — shared behavior", () => {
  it("keeps native-currency cost basis proportional to the ILS cost basis it mirrors", () => {
    const trades = [buy("2023-01-01", 10, 10_000, 270_000), sell("2024-01-01", 4, 20_000, 540_000)];
    const { openLots } = replayTaxLots("AAPL", "USD", trades, "FIFO");
    expect(openLots[0]).toMatchObject({ quantity: 6, costBasisAgorot: 60_000, nativeCostBasis: 1_620_000 });
  });

  it("sorts trades by execution date regardless of input order", () => {
    const trades = [sell("2024-01-01", 5, 20_000, 540_000), buy("2023-01-01", 5, 10_000, 270_000)];
    const { disposals } = replayTaxLots("AAPL", "USD", trades, "FIFO");
    expect(disposals).toHaveLength(1);
    expect(disposals[0].realizedGainAgorot).toBe(50_000);
  });

  it("produces no open lots once a position is fully liquidated", () => {
    const trades = [buy("2023-01-01", 10, 10_000, 270_000), sell("2024-01-01", 10, 20_000, 540_000)];
    const { openLots } = replayTaxLots("AAPL", "USD", trades, "FIFO");
    expect(openLots).toHaveLength(0);
  });

  it("handles fractional (crypto-style) quantities without leaving dust lots", () => {
    const trades = [buy("2023-01-01", 0.5, 3_000_000, 81_000_00), sell("2024-01-01", 0.5, 4_000_000, 108_000_00)];
    const { openLots, disposals } = replayTaxLots("BTC", "USD", trades, "FIFO");
    expect(openLots).toHaveLength(0);
    expect(disposals[0].quantity).toBeCloseTo(0.5);
  });

  it("throws when a trade has non-positive quantity", () => {
    expect(() => replayTaxLots("AAPL", "USD", [buy("2023-01-01", 0, 10_000, 270_000)], "FIFO")).toThrow(RangeError);
    expect(() => replayTaxLots("AAPL", "USD", [sell("2023-01-01", -1, 10_000, 270_000)], "FIFO")).toThrow(RangeError);
  });

  it("throws when a SELL exceeds the shares available in open lots", () => {
    const trades = [buy("2023-01-01", 5, 10_000, 270_000), sell("2024-01-01", 6, 20_000, 540_000)];
    expect(() => replayTaxLots("AAPL", "USD", trades, "FIFO")).toThrow(RangeError);
  });

  it("throws when selling with no prior BUY at all", () => {
    expect(() => replayTaxLots("AAPL", "USD", [sell("2024-01-01", 1, 20_000, 540_000)], "FIFO")).toThrow(RangeError);
  });
});
