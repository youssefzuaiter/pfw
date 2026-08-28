import { agorot, type Agorot } from "./money";

/**
 * A deterministic mock "current price" feed for the simulated trading
 * desk. Prices US equities in shekels (Phase 0 decision #3): a mocked
 * USD base price times a fixed mocked USD->ILS rate, then a small
 * deterministic daily drift so the price actually moves day to day
 * without needing a real market data provider. Same symbol + same
 * calendar day always yields the same price — useful for the dashboard's
 * live net-worth calculation and the /trading screen's ticker alike.
 */

const USD_BASE_PRICE: Record<string, number> = {
  AAPL: 190,
  MSFT: 410,
  GOOGL: 165,
  AMZN: 180,
  NVDA: 135,
};

export const MOCK_USD_TO_ILS_RATE = 3.7;

export function isKnownMockSymbol(symbol: string): boolean {
  return symbol in USD_BASE_PRICE;
}

export function listMockSymbols(): string[] {
  return Object.keys(USD_BASE_PRICE);
}

function dailySeed(symbol: string, date: Date): number {
  const dayKey = date.toISOString().slice(0, 10);
  const input = `${symbol}-${dayKey}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (Math.imul(31, hash) + input.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

/** Deterministic per-symbol-per-day price in agorot. Drifts by up to +/-3% around the base price. */
export function getMockPriceAgorot(symbol: string, asOf: Date = new Date()): Agorot {
  const base = USD_BASE_PRICE[symbol];
  if (base === undefined) {
    throw new RangeError(`Unknown mock symbol: ${symbol}`);
  }

  const seed = dailySeed(symbol, asOf);
  const drift = ((seed % 601) - 300) / 10_000; // -0.03 .. +0.03
  const priceUsd = base * (1 + drift);

  return agorot(Math.round(priceUsd * MOCK_USD_TO_ILS_RATE * 100));
}

export type PricePoint = { date: Date; price: Agorot };

/**
 * A "historical" daily price series for the /trading screen's chart —
 * each point is just `getMockPriceAgorot` evaluated for that past day, so
 * it needs no storage at all: the deterministic per-day drift already
 * means a given day's price never changes once that day has passed.
 */
export function getMockPriceHistory(symbol: string, days: number, endDate: Date = new Date()): PricePoint[] {
  if (days <= 0) {
    throw new RangeError(`days must be positive, received ${days}`);
  }

  const points: PricePoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(endDate.getTime() - i * 24 * 60 * 60 * 1000);
    points.push({ date, price: getMockPriceAgorot(symbol, date) });
  }
  return points;
}
