import { type Agorot } from "./money";
import { nativeAmount, type NativeAmount } from "./currency";
import { FALLBACK_RATES, convertNativeAmountToAgorot } from "./exchange-rate";

/**
 * A deterministic mock "current price" feed for the simulated trading
 * desk. Prices US equities natively in USD cents, then converts to
 * shekels (Phase 0 decision #3, extended in AGENTS.md §3k) via a
 * caller-supplied USD->ILS rate — this module no longer hardcodes that
 * rate itself, since it now comes from the real ExchangeRate sync
 * service rather than a fixed constant. A small deterministic daily
 * drift makes the price actually move day to day without needing a real
 * market data provider. Same symbol + same calendar day always yields
 * the same price — useful for the dashboard's live net-worth calculation
 * and the /trading screen's ticker alike.
 */

export type MockAssetClass = "STOCK" | "ETF" | "CRYPTO";

export type MockInstrument = {
  symbol: string;
  name: string;
  assetClass: MockAssetClass;
  /** Base price in whole USD, before the deterministic daily drift. */
  usdBasePrice: number;
  /**
   * Declared dividend per share in whole USD, and how many times a year
   * it is paid. `null` means the instrument pays nothing — which is a
   * real fact about it (crypto and growth stocks like AMZN/GOOGL/NVDA
   * genuinely pay no dividend), not missing data. See
   * `getMockDividendSchedule`.
   */
  dividend: { amountPerShareUsd: number; paymentsPerYear: number } | null;
};

/**
 * The instrument universe. Prices and dividend rates are plausible
 * real-world-shaped mock values, not live quotes — see the module comment
 * and AGENTS.md §3l for why this stayed a deterministic mock feed rather
 * than becoming a real market-data integration.
 */
const MOCK_INSTRUMENTS: readonly MockInstrument[] = [
  // Dividend-paying large caps.
  { symbol: "AAPL", name: "Apple Inc.", assetClass: "STOCK", usdBasePrice: 190, dividend: { amountPerShareUsd: 0.25, paymentsPerYear: 4 } },
  { symbol: "MSFT", name: "Microsoft Corp.", assetClass: "STOCK", usdBasePrice: 410, dividend: { amountPerShareUsd: 0.83, paymentsPerYear: 4 } },
  // Growth names that pay no dividend at all.
  { symbol: "GOOGL", name: "Alphabet Inc.", assetClass: "STOCK", usdBasePrice: 165, dividend: null },
  { symbol: "AMZN", name: "Amazon.com Inc.", assetClass: "STOCK", usdBasePrice: 180, dividend: null },
  { symbol: "NVDA", name: "NVIDIA Corp.", assetClass: "STOCK", usdBasePrice: 135, dividend: { amountPerShareUsd: 0.01, paymentsPerYear: 4 } },
  // ETFs — distributions are the norm here.
  { symbol: "SPY", name: "SPDR S&P 500 ETF", assetClass: "ETF", usdBasePrice: 545, dividend: { amountPerShareUsd: 1.75, paymentsPerYear: 4 } },
  { symbol: "VOO", name: "Vanguard S&P 500 ETF", assetClass: "ETF", usdBasePrice: 500, dividend: { amountPerShareUsd: 1.6, paymentsPerYear: 4 } },
  { symbol: "QQQ", name: "Invesco QQQ Trust", assetClass: "ETF", usdBasePrice: 470, dividend: { amountPerShareUsd: 0.6, paymentsPerYear: 4 } },
  // Crypto — never pays a dividend.
  { symbol: "BTC", name: "Bitcoin", assetClass: "CRYPTO", usdBasePrice: 62_000, dividend: null },
  { symbol: "ETH", name: "Ethereum", assetClass: "CRYPTO", usdBasePrice: 3_400, dividend: null },
];

const INSTRUMENT_BY_SYMBOL = new Map(MOCK_INSTRUMENTS.map((i) => [i.symbol, i]));

const USD_BASE_PRICE: Record<string, number> = Object.fromEntries(
  MOCK_INSTRUMENTS.map((i) => [i.symbol, i.usdBasePrice]),
);

export function isKnownMockSymbol(symbol: string): boolean {
  return INSTRUMENT_BY_SYMBOL.has(symbol);
}

export function listMockSymbols(): string[] {
  return MOCK_INSTRUMENTS.map((i) => i.symbol);
}

export function listMockInstruments(): readonly MockInstrument[] {
  return MOCK_INSTRUMENTS;
}

export function getMockInstrument(symbol: string): MockInstrument {
  const instrument = INSTRUMENT_BY_SYMBOL.get(symbol);
  if (!instrument) {
    throw new RangeError(`Unknown mock symbol: ${symbol}`);
  }
  return instrument;
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

/** Deterministic per-symbol-per-day price in native USD cents. Drifts by up to +/-3% around the base price. */
export function getMockPriceUsdCents(symbol: string, asOf: Date = new Date()): NativeAmount {
  const base = USD_BASE_PRICE[symbol];
  if (base === undefined) {
    throw new RangeError(`Unknown mock symbol: ${symbol}`);
  }

  const seed = dailySeed(symbol, asOf);
  const drift = ((seed % 601) - 300) / 10_000; // -0.03 .. +0.03
  const priceUsd = base * (1 + drift);

  return nativeAmount(Math.round(priceUsd * 100));
}

/**
 * Deterministic per-symbol-per-day price converted to ILS agorot, using
 * `usdToIlsRate` (ILS per 1 USD) — defaults to `FALLBACK_RATES.USD` so
 * existing callers/tests that don't have a live synced rate handy keep
 * working; a real caller (the trades/portfolio DAL) should pass the
 * latest rate from the ExchangeRate table instead.
 */
export function getMockPriceAgorot(
  symbol: string,
  asOf: Date = new Date(),
  usdToIlsRate: number = FALLBACK_RATES.USD,
): Agorot {
  return convertNativeAmountToAgorot(getMockPriceUsdCents(symbol, asOf), "USD", usdToIlsRate);
}

export type PricePoint = { date: Date; price: Agorot; nativePrice: NativeAmount };

/**
 * A "historical" daily price series for the /trading screen's chart —
 * each point is just `getMockPriceAgorot`/`getMockPriceUsdCents` evaluated
 * for that past day, so it needs no storage at all: the deterministic
 * per-day drift already means a given day's price never changes once
 * that day has passed.
 */
export function getMockPriceHistory(
  symbol: string,
  days: number,
  endDate: Date = new Date(),
  usdToIlsRate: number = FALLBACK_RATES.USD,
): PricePoint[] {
  if (days <= 0) {
    throw new RangeError(`days must be positive, received ${days}`);
  }

  const points: PricePoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(endDate.getTime() - i * 24 * 60 * 60 * 1000);
    points.push({
      date,
      price: getMockPriceAgorot(symbol, date, usdToIlsRate),
      nativePrice: getMockPriceUsdCents(symbol, date),
    });
  }
  return points;
}

export type MockDividendEvent = {
  symbol: string;
  /** Declared amount per single share, in native USD cents. */
  amountPerShareNative: NativeAmount;
  exDate: Date;
  payDate: Date;
};

/** Pay date lands this many days after the ex-dividend date — a typical real-world lag. */
const DIVIDEND_PAY_LAG_DAYS = 21;

function addDaysUtc(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * A deterministic dividend calendar for one symbol, spanning `daysBack`
 * days into the past through `daysForward` days into the future.
 *
 * Ex-dates are anchored to a fixed epoch and spaced by the instrument's
 * payment interval, so the same symbol always produces the same calendar
 * regardless of when it's called — the same property the price feed has,
 * and what lets the seed script and the tests agree without storing
 * anything. Returns an empty array for an instrument that pays nothing
 * (crypto, non-dividend growth stocks); callers must treat that as a real
 * zero, not a lookup failure.
 */
export function getMockDividendSchedule(
  symbol: string,
  asOf: Date = new Date(),
  daysBack = 365,
  daysForward = 365,
): MockDividendEvent[] {
  const instrument = getMockInstrument(symbol);
  if (!instrument.dividend) return [];

  const { amountPerShareUsd, paymentsPerYear } = instrument.dividend;
  const intervalDays = Math.round(365 / paymentsPerYear);

  // A fixed anchor keeps the calendar stable across calls; the per-symbol
  // offset staggers different instruments' ex-dates instead of having
  // every holding pay on exactly the same day, which would look obviously
  // synthetic on the schedule view.
  const anchor = Date.UTC(2020, 0, 15);
  const symbolOffsetDays = dailySeed(symbol, new Date(anchor)) % intervalDays;

  const windowStart = addDaysUtc(asOf, -daysBack).getTime();
  const windowEnd = addDaysUtc(asOf, daysForward).getTime();

  const events: MockDividendEvent[] = [];
  const msPerInterval = intervalDays * 24 * 60 * 60 * 1000;

  // Start from the first interval boundary at or before the window start,
  // then walk forward — this avoids iterating from 2020 for every call.
  const firstIndex = Math.floor((windowStart - anchor) / msPerInterval) - 1;
  for (let i = firstIndex; ; i++) {
    const exDate = new Date(anchor + i * msPerInterval + symbolOffsetDays * 24 * 60 * 60 * 1000);
    if (exDate.getTime() > windowEnd) break;
    if (exDate.getTime() < windowStart) continue;

    events.push({
      symbol,
      amountPerShareNative: nativeAmount(Math.round(amountPerShareUsd * 100)),
      exDate,
      payDate: addDaysUtc(exDate, DIVIDEND_PAY_LAG_DAYS),
    });
  }

  return events;
}
