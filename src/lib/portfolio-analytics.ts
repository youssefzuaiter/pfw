/**
 * Portfolio-level analytics: per-position and whole-portfolio return,
 * allocation by asset class, and dividend yield / payout scheduling.
 *
 * Pure functions over already-fetched data, following the same convention
 * as every other engine in `src/lib/` (AGENTS.md §3b) — nothing here
 * touches the DAL or the database, which is what lets all of it be tested
 * with plain data literals.
 *
 * Every monetary figure is ILS `Agorot` (the base/reporting currency)
 * with a parallel native-currency figure where the underlying fact is
 * natively denominated, exactly as `portfolio-math.ts` does.
 */

import { addAgorot, agorot, multiplyAgorot, subtractAgorot, type Agorot } from "./money";
import {
  addNativeAmounts,
  multiplyNativeAmount,
  nativeAmount,
  type CurrencyCode,
  type NativeAmount,
} from "./currency";

export type AssetClass = "STOCK" | "ETF" | "CRYPTO";

/** One open (or closed) position, as the DAL hands it over. */
export type AnalyticsPosition = {
  symbol: string;
  assetClass: AssetClass;
  currency: CurrencyCode;
  quantity: number;
  totalCostBasis: Agorot;
  nativeCostBasis: NativeAmount;
  /** Live per-share price. */
  currentPrice: Agorot;
  nativeCurrentPrice: NativeAmount;
};

/** A dividend already received on this position — a historical fact. */
export type PaidDividend = {
  symbol: string;
  totalAgorot: Agorot;
  payDate: Date;
};

/** A declared-but-unpaid dividend — its payout is projected, never stored. */
export type AnnouncedDividend = {
  symbol: string;
  currency: CurrencyCode;
  amountPerShareNative: NativeAmount;
  exDate: Date;
  payDate: Date;
};

export type PositionReturn = {
  symbol: string;
  assetClass: AssetClass;
  currency: CurrencyCode;
  quantity: number;
  costBasis: Agorot;
  marketValue: Agorot;
  nativeMarketValue: NativeAmount;
  unrealizedGain: Agorot;
  nativeUnrealizedGain: NativeAmount;
  /**
   * Unrealized gain as a fraction of cost basis (0.1 = +10%). `null` — not
   * 0 — for a zero cost basis: a percentage return on nothing invested is
   * undefined, and reporting it as 0% would read as "flat" when the honest
   * answer is "not meaningful".
   */
  unrealizedReturnRate: number | null;
};

/** Market value and unrealized gain for one position, in both currencies. */
export function summarizePosition(position: AnalyticsPosition): PositionReturn {
  const marketValue = multiplyAgorot(position.currentPrice, position.quantity);
  const nativeMarketValue = multiplyNativeAmount(position.nativeCurrentPrice, position.quantity);
  const unrealizedGain = subtractAgorot(marketValue, position.totalCostBasis);
  const nativeUnrealizedGain = subtractNativeAmountsSafe(nativeMarketValue, position.nativeCostBasis);

  return {
    symbol: position.symbol,
    assetClass: position.assetClass,
    currency: position.currency,
    quantity: position.quantity,
    costBasis: position.totalCostBasis,
    marketValue,
    nativeMarketValue,
    unrealizedGain,
    nativeUnrealizedGain,
    unrealizedReturnRate: position.totalCostBasis === 0 ? null : unrealizedGain / position.totalCostBasis,
  };
}

function subtractNativeAmountsSafe(a: NativeAmount, b: NativeAmount): NativeAmount {
  return nativeAmount(a - b);
}

export type AllocationSlice = {
  assetClass: AssetClass;
  marketValue: Agorot;
  /** Share of total portfolio market value (0..1); 0 when the portfolio is empty. */
  share: number;
};

/**
 * Portfolio composition by asset class. Only classes actually held appear
 * — an empty slice for every unheld class would be noise on the chart.
 */
export function summarizeAllocation(positions: PositionReturn[]): AllocationSlice[] {
  const totalValue = positions.reduce((sum, p) => sum + p.marketValue, 0);

  const byClass = new Map<AssetClass, number>();
  for (const position of positions) {
    byClass.set(position.assetClass, (byClass.get(position.assetClass) ?? 0) + position.marketValue);
  }

  return [...byClass.entries()]
    .map(([assetClass, value]) => ({
      assetClass,
      marketValue: agorot(value),
      share: totalValue === 0 ? 0 : value / totalValue,
    }))
    .sort((a, b) => b.marketValue - a.marketValue);
}

export type PortfolioReturn = {
  totalCostBasis: Agorot;
  totalMarketValue: Agorot;
  unrealizedGain: Agorot;
  realizedGain: Agorot;
  dividendIncome: Agorot;
  /**
   * Every source of return combined: price appreciation on open positions,
   * gains already banked from sales, and dividends received. This is the
   * figure a "total return" headline should show — unrealized gain alone
   * understates performance for a dividend-paying portfolio, which is
   * precisely the gap this module exists to close.
   */
  totalGain: Agorot;
  /**
   * `totalGain` over cost basis. `null` for a zero cost basis — see
   * PositionReturn.unrealizedReturnRate for why not 0.
   */
  totalReturnRate: number | null;
};

/**
 * Whole-portfolio return. `realizedGain` comes from the Trade blotter's
 * stored per-sale realized P&L and `dividendIncome` from PAID Dividend
 * rows — both historical facts the caller reads, never recomputed here
 * (AGENTS.md law #5).
 */
export function summarizePortfolioReturn(
  positions: PositionReturn[],
  realizedGain: Agorot,
  dividendIncome: Agorot,
): PortfolioReturn {
  const totalCostBasis = agorot(positions.reduce((sum, p) => sum + p.costBasis, 0));
  const totalMarketValue = agorot(positions.reduce((sum, p) => sum + p.marketValue, 0));
  const unrealizedGain = subtractAgorot(totalMarketValue, totalCostBasis);
  const totalGain = addAgorot(unrealizedGain, realizedGain, dividendIncome);

  return {
    totalCostBasis,
    totalMarketValue,
    unrealizedGain,
    realizedGain,
    dividendIncome,
    totalGain,
    totalReturnRate: totalCostBasis === 0 ? null : totalGain / totalCostBasis,
  };
}

export type UpcomingPayout = {
  symbol: string;
  currency: CurrencyCode;
  exDate: Date;
  payDate: Date;
  amountPerShareNative: NativeAmount;
  quantity: number;
  /** Projected, never stored — quantity and FX rate both still move before pay date. */
  projectedNativeAmount: NativeAmount;
  projectedAgorot: Agorot;
};

/**
 * The upcoming dividend payout schedule: every announced dividend with a
 * pay date in the future, for a symbol the user actually still holds,
 * soonest first.
 *
 * Positions held at quantity 0 are excluded — a fully-liquidated holding
 * is kept in the DB (deleting it would cascade away its trade history,
 * see PortfolioHolding's schema comment) but will receive nothing, so
 * listing a payout against it would be wrong, not merely noisy.
 */
export function buildUpcomingPayouts(
  announced: AnnouncedDividend[],
  positions: AnalyticsPosition[],
  rateTable: Readonly<Record<CurrencyCode, number>>,
  asOf: Date = new Date(),
): UpcomingPayout[] {
  const quantityBySymbol = new Map(positions.map((p) => [p.symbol, p.quantity]));

  return announced
    .filter((dividend) => dividend.payDate.getTime() > asOf.getTime())
    .flatMap((dividend) => {
      const quantity = quantityBySymbol.get(dividend.symbol) ?? 0;
      if (quantity <= 0) return [];

      const projectedNativeAmount = multiplyNativeAmount(dividend.amountPerShareNative, quantity);
      const rate = rateTable[dividend.currency];
      const projectedAgorot =
        dividend.currency === "ILS"
          ? agorot(projectedNativeAmount)
          : agorot(Math.round(projectedNativeAmount * rate));

      return [
        {
          symbol: dividend.symbol,
          currency: dividend.currency,
          exDate: dividend.exDate,
          payDate: dividend.payDate,
          amountPerShareNative: dividend.amountPerShareNative,
          quantity,
          projectedNativeAmount,
          projectedAgorot,
        },
      ];
    })
    .sort((a, b) => a.payDate.getTime() - b.payDate.getTime());
}

/**
 * Trailing dividend yield for one position: the last 12 months of *paid*
 * dividends over the position's current market value.
 *
 * Deliberately trailing-actual rather than forward-projected — a forward
 * yield would require assuming the declared rate continues unchanged for
 * a year, which is an assumption this app has no basis to make. Returns
 * `null` for a zero market value rather than dividing by zero.
 */
export function computeTrailingYield(
  position: PositionReturn,
  paidDividends: PaidDividend[],
  asOf: Date = new Date(),
): number | null {
  if (position.marketValue === 0) return null;

  const oneYearAgo = new Date(asOf.getTime() - 365 * 24 * 60 * 60 * 1000);
  const trailingTotal = paidDividends
    .filter((d) => d.symbol === position.symbol)
    .filter((d) => d.payDate.getTime() > oneYearAgo.getTime() && d.payDate.getTime() <= asOf.getTime())
    .reduce((sum, d) => sum + d.totalAgorot, 0);

  return trailingTotal / position.marketValue;
}

/** Total dividend income actually received in a window — a sum of stored historical facts. */
export function sumDividendIncome(paidDividends: PaidDividend[], since?: Date, until?: Date): Agorot {
  const total = paidDividends
    .filter((d) => (since === undefined ? true : d.payDate.getTime() >= since.getTime()))
    .filter((d) => (until === undefined ? true : d.payDate.getTime() <= until.getTime()))
    .reduce((sum, d) => sum + d.totalAgorot, 0);
  return agorot(total);
}

/** Sum of native-currency payouts, for the schedule view's per-currency subtotal. */
export function sumProjectedNative(payouts: UpcomingPayout[], currency: CurrencyCode): NativeAmount {
  return addNativeAmounts(
    ...payouts.filter((p) => p.currency === currency).map((p) => p.projectedNativeAmount),
  );
}
