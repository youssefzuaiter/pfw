/**
 * FIFO/LIFO tax-lot cost-basis engine — pure, "derived truth" replay over
 * Trade history (AGENTS.md law #5): nothing here is stored as its own row.
 * Every BUY/SELL already lives in the Trade blotter, so lots are
 * recomputed from that history on every call, never persisted.
 *
 * This is a DIFFERENT accounting method than a PortfolioHolding's own
 * stored weighted-average cost basis (`portfolio-math.ts`), which still
 * drives the live position P&L shown on `/trading`/`/trading/portfolio`
 * and is NOT changed by this module. FIFO/LIFO lot identification exists
 * specifically for tax simulation: real capital-gains tax law (US
 * Schedule D, German Abgeltungssteuer, etc.) requires knowing *which*
 * specific shares were sold, because the answer changes both the realized
 * gain and its holding period — the app's actual trade execution/blotter
 * keeps reporting weighted-average P&L exactly as before; this engine
 * answers a "what would my tax lots look like" question alongside it.
 */

import { agorot, multiplyAgorot, subtractAgorot, type Agorot } from "./money";
import { multiplyNativeAmount, subtractNativeAmounts, type CurrencyCode, type NativeAmount } from "./currency";

export type CostBasisMethod = "FIFO" | "LIFO";

export type LotTradeEvent = {
  side: "BUY" | "SELL";
  quantity: number;
  executedAt: Date;
  /** Per-share execution price, both currencies — same fact `Trade.priceAgorot`/`nativePriceAmount` capture. */
  priceAgorot: Agorot;
  nativePricePerShare: NativeAmount;
};

export type OpenTaxLot = {
  symbol: string;
  currency: CurrencyCode;
  acquiredAt: Date;
  quantity: number;
  costBasisAgorot: Agorot;
  nativeCostBasis: NativeAmount;
};

export type LotDisposal = {
  symbol: string;
  currency: CurrencyCode;
  acquiredAt: Date;
  disposedAt: Date;
  quantity: number;
  costBasisAgorot: Agorot;
  proceedsAgorot: Agorot;
  realizedGainAgorot: Agorot;
  holdingPeriodDays: number;
};

export type LotReplayResult = {
  openLots: OpenTaxLot[];
  disposals: LotDisposal[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Fractional-share quantities (crypto, `Decimal(20,8)`) can leave a sub-cent remainder after
 * repeated partial consumption — treat anything this small as fully consumed/satisfied. */
const QUANTITY_EPSILON = 1e-8;

export function holdingPeriodDays(acquiredAt: Date, asOf: Date): number {
  return Math.round((asOf.getTime() - acquiredAt.getTime()) / DAY_MS);
}

function findOldestOpenLotIndex(lots: readonly OpenTaxLot[]): number {
  return lots.findIndex((lot) => lot.quantity > QUANTITY_EPSILON);
}

function findNewestOpenLotIndex(lots: readonly OpenTaxLot[]): number {
  for (let i = lots.length - 1; i >= 0; i--) {
    if (lots[i].quantity > QUANTITY_EPSILON) return i;
  }
  return -1;
}

/**
 * Replays one symbol's full trade history in chronological order,
 * matching each SELL against open BUY lots via FIFO (oldest lot first) or
 * LIFO (newest lot first). A SELL that spans more than one lot produces
 * one `LotDisposal` per lot it draws from, each with that lot's own
 * acquisition date and per-lot realized gain/holding period.
 *
 * Throws if a SELL can't be fully matched against open lots — that would
 * mean the trade history itself sold more than was ever bought, which is
 * a data-integrity bug this engine should surface loudly, not paper over.
 */
export function replayTaxLots(
  symbol: string,
  currency: CurrencyCode,
  trades: readonly LotTradeEvent[],
  method: CostBasisMethod,
): LotReplayResult {
  const sorted = [...trades].sort((a, b) => a.executedAt.getTime() - b.executedAt.getTime());

  const lots: OpenTaxLot[] = [];
  const disposals: LotDisposal[] = [];

  for (const trade of sorted) {
    if (trade.quantity <= 0) {
      throw new RangeError(`Trade quantity must be positive, received ${trade.quantity}`);
    }

    if (trade.side === "BUY") {
      lots.push({
        symbol,
        currency,
        acquiredAt: trade.executedAt,
        quantity: trade.quantity,
        costBasisAgorot: multiplyAgorot(trade.priceAgorot, trade.quantity),
        nativeCostBasis: multiplyNativeAmount(trade.nativePricePerShare, trade.quantity),
      });
      continue;
    }

    let remainingToSell = trade.quantity;
    while (remainingToSell > QUANTITY_EPSILON) {
      const lotIndex = method === "FIFO" ? findOldestOpenLotIndex(lots) : findNewestOpenLotIndex(lots);
      if (lotIndex === -1) {
        throw new RangeError(
          `SELL of ${trade.quantity} ${symbol} on ${trade.executedAt.toISOString()} exceeds the shares available in open lots`,
        );
      }

      const lot = lots[lotIndex];
      const takeQuantity = Math.min(lot.quantity, remainingToSell);
      const fraction = takeQuantity / lot.quantity;
      const costBasisTaken = agorot(Math.round(lot.costBasisAgorot * fraction));
      const nativeCostBasisTaken = multiplyNativeAmount(lot.nativeCostBasis, fraction);

      const proceedsAgorot = multiplyAgorot(trade.priceAgorot, takeQuantity);
      const realizedGainAgorot = subtractAgorot(proceedsAgorot, costBasisTaken);

      disposals.push({
        symbol,
        currency,
        acquiredAt: lot.acquiredAt,
        disposedAt: trade.executedAt,
        quantity: takeQuantity,
        costBasisAgorot: costBasisTaken,
        proceedsAgorot,
        realizedGainAgorot,
        holdingPeriodDays: holdingPeriodDays(lot.acquiredAt, trade.executedAt),
      });

      lot.quantity -= takeQuantity;
      lot.costBasisAgorot = subtractAgorot(lot.costBasisAgorot, costBasisTaken);
      lot.nativeCostBasis = subtractNativeAmounts(lot.nativeCostBasis, nativeCostBasisTaken);
      remainingToSell -= takeQuantity;
    }
  }

  return {
    openLots: lots.filter((lot) => lot.quantity > QUANTITY_EPSILON),
    disposals,
  };
}
