import { agorot, type Agorot } from "./money";
import { nativeAmount, type NativeAmount } from "./currency";
import { getMockPriceAgorot, getMockPriceUsdCents, isKnownMockSymbol } from "./mock-market-data";

/**
 * Where a holding's "current price" actually came from.
 *
 * - `mock_feed`: one of the seeded instruments, priced by the deterministic
 *   mock feed (`mock-market-data.ts`) — the only source this app had
 *   until the paper trader (AGENTS.md §3uu) started booking REAL Alpaca
 *   fills for whatever ticker a headline named.
 * - `last_fill`: a symbol the mock feed has never heard of, valued at the
 *   price of the most recent fill this user has for it — the last real
 *   market price this app ever observed for that instrument.
 * - `cost_basis`: no fill on record either (a holding written by a path
 *   that never booked a trade row) — valued at its own average cost, i.e.
 *   an honest "no gain, no loss" rather than a guess.
 */
export type HoldingPriceSource = "mock_feed" | "last_fill" | "cost_basis";

export type ResolvedHoldingPrice = {
  priceAgorot: Agorot;
  nativePrice: NativeAmount;
  source: HoldingPriceSource;
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
 * A holding this app cannot price is still an asset the user owns; the
 * fallback chain prices it from the best evidence on hand and SAYS which
 * evidence that was, so a screen can label a stale figure instead of
 * passing it off as live.
 *
 * Pure: the caller supplies the last fill (a DAL lookup) — see
 * `resolveHoldingPrices` in `src/server/dal/portfolio.ts`.
 */
export function resolveHoldingPrice(
  holding: PricableHolding,
  lastFill: LastFillPrice | undefined,
  asOf: Date,
  usdToIlsRate: number,
): ResolvedHoldingPrice {
  if (isKnownMockSymbol(holding.symbol)) {
    return {
      priceAgorot: getMockPriceAgorot(holding.symbol, asOf, usdToIlsRate),
      nativePrice: getMockPriceUsdCents(holding.symbol, asOf),
      source: "mock_feed",
    };
  }

  if (lastFill) {
    return { priceAgorot: lastFill.priceAgorot, nativePrice: lastFill.nativePrice, source: "last_fill" };
  }

  // Average cost per share. A closed-out position (quantity 0, kept for
  // its trade history — see PortfolioHolding's schema comment) has no
  // per-share figure to derive, and contributes 0 to every total anyway.
  if (holding.quantity <= 0) {
    return { priceAgorot: agorot(0), nativePrice: nativeAmount(0), source: "cost_basis" };
  }
  return {
    priceAgorot: agorot(Math.round(holding.totalCostBasis / holding.quantity)),
    nativePrice: nativeAmount(Math.round(holding.nativeCostBasis / holding.quantity)),
    source: "cost_basis",
  };
}

/** `resolveHoldingPrice` over a set of holdings, keyed by symbol. */
export function resolveHoldingPrices(
  holdings: readonly PricableHolding[],
  lastFillBySymbol: ReadonlyMap<string, LastFillPrice>,
  asOf: Date,
  usdToIlsRate: number,
): Map<string, ResolvedHoldingPrice> {
  return new Map(
    holdings.map((holding) => [
      holding.symbol,
      resolveHoldingPrice(holding, lastFillBySymbol.get(holding.symbol), asOf, usdToIlsRate),
    ]),
  );
}
