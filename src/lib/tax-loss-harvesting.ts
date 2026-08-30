/**
 * Tax-Loss Harvesting Radar — surfaces open tax lots sitting at an
 * unrealized loss that could be sold to offset realized gains elsewhere
 * in the portfolio, reducing simulated tax liability. Pure function over
 * already-computed lots (`tax-lots.ts`) and the current mock price feed,
 * same `src/lib/` convention as every other engine (AGENTS.md §3b) —
 * named and shaped after the existing subscription radar
 * (`subscription-radar.ts`): detect candidates, rank them, and leave the
 * actual decision to the user.
 */

import { agorot, subtractAgorot, type Agorot } from "./money";
import { holdingPeriodDays, type OpenTaxLot } from "./tax-lots";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The US wash-sale rule's window (30 days before or after the sale); used here as a
 * general anti-abuse-rule proxy for other jurisdictions too, since most modeled
 * jurisdictions have some analogous "don't just rebuy it back" restriction and this
 * simulator doesn't attempt to encode each one individually. */
export const WASH_SALE_WINDOW_DAYS = 30;

export type HarvestCandidate = {
  symbol: string;
  acquiredAt: Date;
  quantity: number;
  costBasisAgorot: Agorot;
  currentValueAgorot: Agorot;
  /** Always negative — only loss positions are candidates. */
  unrealizedLossAgorot: Agorot;
  holdingPeriodDays: number;
  /**
   * True when a BUY of this symbol was executed within the wash-sale
   * window before `asOf` — harvesting this lot now would very likely have
   * the loss disallowed. This only checks the *past* half of the real
   * 30-days-before-or-after window: a future repurchase obviously hasn't
   * happened yet at simulation time, so this is a "you're already at
   * risk" flag, not a guarantee the loss would be honored either way.
   */
  washSaleRisk: boolean;
  /** A rough, blended estimate — see `findHarvestCandidates`'s doc comment for how the rate is derived. */
  estimatedTaxSavingsAgorot: Agorot;
};

/**
 * Finds every open lot currently sitting at an unrealized loss, ranked
 * biggest loss first. `estimatedMarginalRate` is a single blended rate
 * (0..1) applied uniformly to every candidate's loss magnitude — a real
 * harvest's actual benefit depends on which specific gain it offsets and
 * would need a full before/after re-simulation to state precisely; this
 * is a fast, honestly-approximate estimate, not that full re-simulation
 * (build-tax-data.ts documents how the rate itself is derived).
 */
export function findHarvestCandidates(
  openLots: readonly OpenTaxLot[],
  currentPriceBySymbol: ReadonlyMap<string, Agorot>,
  recentBuyDatesBySymbol: ReadonlyMap<string, readonly Date[]>,
  estimatedMarginalRate: number,
  asOf: Date = new Date(),
): HarvestCandidate[] {
  const candidates: HarvestCandidate[] = [];

  for (const lot of openLots) {
    const price = currentPriceBySymbol.get(lot.symbol);
    if (price === undefined) continue;

    const currentValueAgorot = agorot(Math.round(price * lot.quantity));
    const unrealizedGainAgorot = subtractAgorot(currentValueAgorot, lot.costBasisAgorot);
    if (unrealizedGainAgorot >= 0) continue;

    const recentBuys = recentBuyDatesBySymbol.get(lot.symbol) ?? [];
    const washSaleRisk = recentBuys.some(
      (buyDate) => (asOf.getTime() - buyDate.getTime()) / DAY_MS <= WASH_SALE_WINDOW_DAYS && buyDate.getTime() <= asOf.getTime(),
    );

    candidates.push({
      symbol: lot.symbol,
      acquiredAt: lot.acquiredAt,
      quantity: lot.quantity,
      costBasisAgorot: lot.costBasisAgorot,
      currentValueAgorot,
      unrealizedLossAgorot: unrealizedGainAgorot,
      holdingPeriodDays: holdingPeriodDays(lot.acquiredAt, asOf),
      washSaleRisk,
      estimatedTaxSavingsAgorot: agorot(Math.round(Math.abs(unrealizedGainAgorot) * Math.max(0, estimatedMarginalRate))),
    });
  }

  return candidates.sort((a, b) => a.unrealizedLossAgorot - b.unrealizedLossAgorot);
}

export type HarvestPotentialSummary = {
  totalHarvestableLossAgorot: Agorot;
  totalEstimatedTaxSavingsAgorot: Agorot;
  washSaleFlaggedCount: number;
};

export function summarizeHarvestPotential(candidates: readonly HarvestCandidate[]): HarvestPotentialSummary {
  return {
    totalHarvestableLossAgorot: agorot(candidates.reduce((sum, c) => sum + c.unrealizedLossAgorot, 0)),
    totalEstimatedTaxSavingsAgorot: agorot(candidates.reduce((sum, c) => sum + c.estimatedTaxSavingsAgorot, 0)),
    washSaleFlaggedCount: candidates.filter((c) => c.washSaleRisk).length,
  };
}
