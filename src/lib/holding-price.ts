import { agorot, type Agorot } from "./money";
import { convertNativeAmountToAgorot } from "./exchange-rate";
import { nativeAmount, type NativeAmount } from "./currency";
import { getMockPriceAgorot, getMockPriceUsdCents, isKnownMockSymbol } from "./mock-market-data";

/**
 * Where a holding's "current price" actually came from.
 *
 * - `mock_feed`: one of the seeded instruments, priced by the deterministic
 *   mock feed (`mock-market-data.ts`) — the only source this app had
 *   until the paper trader (AGENTS.md §3uu) started booking REAL Alpaca
 *   fills for whatever ticker a headline named.
 * - `quote`: a symbol outside the mock universe, valued at the newest
 *   real market quote this app has stored for it (`EquityQuote`, synced
 *   daily from the trader's Alpaca feed — §3xx).
 * - `last_fill`: no quote, or the quote is OLDER than this user's most
 *   recent fill for the symbol — valued at that fill, the last real
 *   market price this app observed for it.
 * - `cost_basis`: neither on record (a holding written by a path that
 *   never booked a trade row) — valued at its own average cost, i.e. an
 *   honest "no gain, no loss" rather than a guess.
 */
export type HoldingPriceSource = "mock_feed" | "quote" | "last_fill" | "cost_basis";

export type ResolvedHoldingPrice = {
  priceAgorot: Agorot;
  nativePrice: NativeAmount;
  source: HoldingPriceSource;
  /** When the price was observed in the market — `null` for the mock feed and for cost basis, which are not observations. */
  observedAt: Date | null;
};

export type PricableHolding = {
  symbol: string;
  quantity: number;
  totalCostBasis: Agorot;
  nativeCostBasis: NativeAmount;
};

/** The most recent fill for a symbol — per-share, both denominations. */
export type LastFillPrice = {
  priceAgorot: Agorot;
  nativePrice: NativeAmount;
  executedAt: Date;
};

/** The newest stored market quote for a symbol, USD per share. */
export type QuotePrice = {
  priceUsd: number;
  observedAt: Date;
};

export type PriceEvidence = {
  lastFill?: LastFillPrice;
  quote?: QuotePrice;
};

/**
 * Resolve the per-share price to value a holding at.
 *
 * Before this existed every consumer called `getMockPriceAgorot(symbol)`
 * directly, which THROWS for a symbol outside the 10-instrument mock
 * universe — and since `computeLiveNetWorth` values every holding, one
 * TSLA position booked by the paper trader took down `/dashboard`,
 * `/trading/portfolio` and the advisor's holdings tool for that account
 * on every load (found live, the same deterministic digest each time).
 * A holding this app cannot price from the mock feed is still an asset
 * the user owns; the chain below prices it from the best evidence on
 * hand — the NEWEST real observation wins between a stored quote and
 * the user's last fill — and SAYS which evidence that was, so a screen
 * can label a stale figure instead of passing it off as live.
 *
 * Pure: the caller supplies the evidence (DAL lookups) — see
 * `resolveHoldingPrices` in `src/server/dal/portfolio.ts`.
 */
export function resolveHoldingPrice(
  holding: PricableHolding,
  evidence: PriceEvidence,
  asOf: Date,
  usdToIlsRate: number,
): ResolvedHoldingPrice {
  if (isKnownMockSymbol(holding.symbol)) {
    return {
      priceAgorot: getMockPriceAgorot(holding.symbol, asOf, usdToIlsRate),
      nativePrice: getMockPriceUsdCents(holding.symbol, asOf),
      source: "mock_feed",
      observedAt: null,
    };
  }

  const { lastFill, quote } = evidence;
  const quoteIsNewer = quote !== undefined && (lastFill === undefined || quote.observedAt.getTime() >= lastFill.executedAt.getTime());
  if (quote && quoteIsNewer) {
    const nativePrice = nativeAmount(Math.round(quote.priceUsd * 100));
    return {
      priceAgorot: convertNativeAmountToAgorot(nativePrice, "USD", usdToIlsRate),
      nativePrice,
      source: "quote",
      observedAt: quote.observedAt,
    };
  }

  if (lastFill) {
    return { priceAgorot: lastFill.priceAgorot, nativePrice: lastFill.nativePrice, source: "last_fill", observedAt: lastFill.executedAt };
  }

  // Average cost per share. A closed-out position (quantity 0, kept for
  // its trade history — see PortfolioHolding's schema comment) has no
  // per-share figure to derive, and contributes 0 to every total anyway.
  if (holding.quantity <= 0) {
    return { priceAgorot: agorot(0), nativePrice: nativeAmount(0), source: "cost_basis", observedAt: null };
  }
  return {
    priceAgorot: agorot(Math.round(holding.totalCostBasis / holding.quantity)),
    nativePrice: nativeAmount(Math.round(holding.nativeCostBasis / holding.quantity)),
    source: "cost_basis",
    observedAt: null,
  };
}

/** `resolveHoldingPrice` over a set of holdings, keyed by symbol. */
export function resolveHoldingPrices(
  holdings: readonly PricableHolding[],
  lastFillBySymbol: ReadonlyMap<string, LastFillPrice>,
  quoteBySymbol: ReadonlyMap<string, QuotePrice>,
  asOf: Date,
  usdToIlsRate: number,
): Map<string, ResolvedHoldingPrice> {
  return new Map(
    holdings.map((holding) => [
      holding.symbol,
      resolveHoldingPrice(
        holding,
        { lastFill: lastFillBySymbol.get(holding.symbol), quote: quoteBySymbol.get(holding.symbol) },
        asOf,
        usdToIlsRate,
      ),
    ]),
  );
}

/** A quote or fill older than this reads as stale enough to label on screen. */
export const STALE_PRICE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * The short caption a screen shows beside a non-feed price, or `null`
 * when the price needs no caveat (the mock feed, or a quote observed
 * within the last day). Kept here so `/trading` and `/trading/portfolio`
 * word it identically.
 */
export function describeHoldingPriceSource(price: ResolvedHoldingPrice, asOf: Date): string | null {
  switch (price.source) {
    case "mock_feed":
      return null;
    case "quote":
      return price.observedAt && asOf.getTime() - price.observedAt.getTime() > STALE_PRICE_AFTER_MS
        ? `quote from ${price.observedAt.toISOString().slice(0, 10)}`
        : null;
    case "last_fill":
      return "valued at last fill";
    case "cost_basis":
      return "valued at cost";
  }
}
