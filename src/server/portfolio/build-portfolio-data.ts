import "server-only";
import { cache } from "react";
import { agorot } from "../../lib/money";
import { nativeAmount } from "../../lib/currency";
import { findMockInstrument } from "../../lib/mock-market-data";
import { describeHoldingPriceSource, type HoldingPriceSource } from "../../lib/holding-price";
import {
  buildUpcomingPayouts,
  computeTrailingYield,
  sumDividendIncome,
  summarizeAllocation,
  summarizePortfolioReturn,
  summarizePosition,
  type AllocationSlice,
  type AnalyticsPosition,
  type PortfolioReturn,
  type PositionReturn,
  type UpcomingPayout,
} from "../../lib/portfolio-analytics";
import { listAnnouncedDividends, listPaidDividends } from "../dal/dividends";
import { getLatestRateTable } from "../dal/exchange-rates";
import { listPortfolioHoldings, listTrades, resolveHoldingPrices } from "../dal/portfolio";

export type PortfolioRow = PositionReturn & {
  name: string;
  /** Where `currentPrice` came from. */
  priceSource: HoldingPriceSource;
  /** The caveat `/trading/portfolio` shows beside a price that isn't a live figure ("valued at last fill", "quote from 2026-09-10"), or `null`. */
  priceCaption: string | null;
  /** Trailing 12-month dividend yield, or null when market value is zero. */
  trailingYield: number | null;
};

export type PortfolioData = {
  rows: PortfolioRow[];
  allocation: AllocationSlice[];
  totals: PortfolioReturn;
  upcomingPayouts: UpcomingPayout[];
  /** Dividends received in the trailing 12 months. */
  trailingDividendIncome: ReturnType<typeof sumDividendIncome>;
  asOf: Date;
};

/**
 * Assembles everything the /trading/portfolio screen renders.
 *
 * Wrapped in React's `cache()` — request-scoped, deliberately not Next's
 * `'use cache'`, for exactly the reason AGENTS.md §3c gives: this is
 * per-user financial data, and a cross-request cache scoped even slightly
 * wrong would serve one user's portfolio to another. `cache()` never
 * crosses a request boundary.
 */
export const buildPortfolioData = cache(async function buildPortfolioData(
  userId: string,
  asOf: Date = new Date(),
): Promise<PortfolioData> {
  const [holdings, trades, announced, paid, rateTable] = await Promise.all([
    listPortfolioHoldings(userId),
    listTrades(userId),
    listAnnouncedDividends(userId),
    listPaidDividends(userId),
    getLatestRateTable(asOf),
  ]);

  const holdingPrices = await resolveHoldingPrices(userId, holdings, asOf, rateTable.USD);
  const positions: AnalyticsPosition[] = holdings.map((holding) => ({
    symbol: holding.symbol,
    assetClass: holding.assetClass,
    currency: holding.currency,
    quantity: holding.quantity.toNumber(),
    totalCostBasis: agorot(Number(holding.totalCostBasis)),
    nativeCostBasis: nativeAmount(Number(holding.nativeCostBasis)),
    currentPrice: holdingPrices.get(holding.symbol)!.priceAgorot,
    nativeCurrentPrice: holdingPrices.get(holding.symbol)!.nativePrice,
  }));

  // Closed-out positions are kept in the DB (deleting one would cascade
  // away its trade history — see PortfolioHolding's schema comment) but
  // don't belong in a holdings table or an allocation chart.
  const openPositions = positions.filter((position) => position.quantity > 0);

  const rows: PortfolioRow[] = openPositions.map((position) => {
    const summary = summarizePosition(position);
    return {
      ...summary,
      // A ticker outside the mock universe (a paper-trader fill) has no
      // instrument record — the bare symbol is the honest label.
      name: findMockInstrument(position.symbol)?.name ?? position.symbol,
      priceSource: holdingPrices.get(position.symbol)!.source,
      priceCaption: describeHoldingPriceSource(holdingPrices.get(position.symbol)!, asOf),
      trailingYield: computeTrailingYield(summary, paid, asOf),
    };
  });

  // Realized P&L is read from the blotter's stored per-sale figure, never
  // recomputed — the cost basis it was measured against no longer exists
  // once the position moved on (AGENTS.md law #5 / Trade's schema comment).
  const realizedGain = agorot(
    trades.reduce((sum, trade) => sum + Number(trade.realizedPnlAgorot ?? 0n), 0),
  );

  const oneYearAgo = new Date(asOf.getTime() - 365 * 24 * 60 * 60 * 1000);
  const trailingDividendIncome = sumDividendIncome(paid, oneYearAgo, asOf);
  const lifetimeDividendIncome = sumDividendIncome(paid);

  return {
    rows: rows.sort((a, b) => b.marketValue - a.marketValue),
    allocation: summarizeAllocation(rows),
    totals: summarizePortfolioReturn(rows, realizedGain, lifetimeDividendIncome),
    upcomingPayouts: buildUpcomingPayouts(announced, openPositions, rateTable, asOf),
    trailingDividendIncome,
    asOf,
  };
});
