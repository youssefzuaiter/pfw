/**
 * HIFO (Highest-In, First-Out) consumption over PERSISTED `HoldingLot`
 * rows — a genuinely different concern from `tax-lots.ts`'s FIFO/LIFO
 * REPLAY engine, which recomputes lots fresh from `Trade` history on
 * every call and stores nothing at all (AGENTS.md §3r's deliberate
 * "derived truth" design for the hypothetical tax simulator). This
 * module answers a different question: "given the lots that are
 * ACTUALLY still open right now, how does this ONE incoming sell
 * consume them" — the DAL fetches the real `HoldingLot` rows, this pure
 * function decides the consumption plan and realized gain, and the DAL
 * applies the resulting writes, all inside one transaction. Same
 * `src/lib/` convention as every other engine in this app (§3b): no DB,
 * no Prisma types, directly testable with plain object literals.
 *
 * Sorts by PER-SHARE cost (`costBasisAgorot / quantity`), descending —
 * deliberately NOT by raw total `costBasisAgorot`, which would be a
 * real, meaningful bug: a large lot bought cheap can have a bigger
 * TOTAL cost basis than a small lot bought expensive, and sorting by
 * the raw total would consume the wrong shares first, defeating the
 * entire point of HIFO (minimizing realized gain — or maximizing a
 * realized loss — by disposing of the highest per-share-cost shares
 * first).
 */
import { agorot, addAgorot, multiplyAgorot, subtractAgorot, type Agorot } from "./money";

export type OpenHoldingLot = {
  id: string;
  quantity: number;
  costBasisAgorot: Agorot;
};

export type LotConsumption = {
  lotId: string;
  quantityConsumed: number;
  costBasisConsumedAgorot: Agorot;
  /** This lot's quantity/cost basis AFTER this consumption — 0 means fully exhausted. */
  remainingQuantity: number;
  remainingCostBasisAgorot: Agorot;
};

export type HifoSellResult = {
  consumptions: LotConsumption[];
  totalCostBasisAgorot: Agorot;
  realizedGainAgorot: Agorot;
};

/** Fractional-share quantities (Decimal(30,18)) can leave a sub-cent remainder after repeated partial consumption — treat anything this small as fully consumed/satisfied. Same epsilon tax-lots.ts's own OpenTaxLot uses. */
const QUANTITY_EPSILON = 1e-9;

function perShareCost(lot: OpenHoldingLot): number {
  return lot.quantity > 0 ? Number(lot.costBasisAgorot) / lot.quantity : 0;
}

/**
 * Consumes `sellQuantity` shares from `lots` via HIFO, computing the
 * realized gain/loss against `sellPriceAgorot` (this sale's per-share
 * price). Throws if the open lots don't cover the full sell quantity —
 * that would mean selling more than is actually held, a data-integrity
 * bug this function should surface loudly, not paper over (the same
 * stance `tax-lots.ts`'s own `replayTaxLots` takes for the identical
 * failure mode).
 */
export function consumeLotsHifo(
  lots: readonly OpenHoldingLot[],
  sellQuantity: number,
  sellPriceAgorot: Agorot,
): HifoSellResult {
  if (sellQuantity <= 0) {
    throw new RangeError(`sellQuantity must be positive, received ${sellQuantity}`);
  }

  const sorted = [...lots]
    .filter((lot) => lot.quantity > QUANTITY_EPSILON)
    .sort((a, b) => perShareCost(b) - perShareCost(a));

  let remaining = sellQuantity;
  const consumptions: LotConsumption[] = [];
  const costBasisTakenPerLot: Agorot[] = [];

  for (const lot of sorted) {
    if (remaining <= QUANTITY_EPSILON) break;

    const takeQuantity = Math.min(lot.quantity, remaining);
    const fraction = takeQuantity / lot.quantity;
    const costBasisConsumedAgorot = agorot(Math.round(Number(lot.costBasisAgorot) * fraction));

    consumptions.push({
      lotId: lot.id,
      quantityConsumed: takeQuantity,
      costBasisConsumedAgorot,
      remainingQuantity: lot.quantity - takeQuantity,
      remainingCostBasisAgorot: subtractAgorot(lot.costBasisAgorot, costBasisConsumedAgorot),
    });
    costBasisTakenPerLot.push(costBasisConsumedAgorot);
    remaining -= takeQuantity;
  }

  if (remaining > QUANTITY_EPSILON) {
    throw new RangeError(
      `Cannot sell ${sellQuantity} shares — only ${sellQuantity - remaining} available across open HoldingLot rows`,
    );
  }

  const totalCostBasisAgorot = costBasisTakenPerLot.length > 0 ? addAgorot(...costBasisTakenPerLot) : agorot(0);
  const proceedsAgorot = multiplyAgorot(sellPriceAgorot, sellQuantity);
  const realizedGainAgorot = subtractAgorot(proceedsAgorot, totalCostBasisAgorot);

  return { consumptions, totalCostBasisAgorot, realizedGainAgorot };
}

export type CostBasisByDatePoint = { dateKey: string; cumulativeCostBasisAgorot: Agorot };

/**
 * Cumulative OPEN cost basis, bucketed by original acquisition date
 * (Phase 2, ad hoc — the portfolio chart's area series). Deliberately
 * titled "by acquisition date," never "cost basis over time": a
 * `HoldingLot` row's `costBasis` is mutated down in place as it's
 * partially consumed (see this file's own header comment and
 * `HoldingLot`'s schema doc comment), so today's remaining amount is NOT
 * what that lot's cost basis actually was on its acquisition date —
 * this reconstructs "how much of today's still-open cost basis traces
 * back to which acquisition dates," not a true historical time series,
 * which this table's mutate-in-place shape cannot reconstruct without a
 * separate history log this app doesn't keep. Two lots acquired the same
 * calendar day are merged into one point, since the chart's x-axis has
 * day resolution.
 */
export function buildCumulativeCostBasisByDate(
  lots: readonly { acquiredAt: Date; costBasisAgorot: Agorot }[],
): CostBasisByDatePoint[] {
  const byDate = new Map<string, Agorot>();
  for (const lot of [...lots].sort((a, b) => a.acquiredAt.getTime() - b.acquiredAt.getTime())) {
    const dateKey = lot.acquiredAt.toISOString().slice(0, 10);
    byDate.set(dateKey, addAgorot(byDate.get(dateKey) ?? agorot(0), lot.costBasisAgorot));
  }

  let running = agorot(0);
  const points: CostBasisByDatePoint[] = [];
  for (const [dateKey, dayTotal] of byDate) {
    running = addAgorot(running, dayTotal);
    points.push({ dateKey, cumulativeCostBasisAgorot: running });
  }
  return points;
}
