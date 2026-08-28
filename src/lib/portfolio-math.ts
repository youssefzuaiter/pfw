import { addAgorot, agorot, multiplyAgorot, subtractAgorot, type Agorot } from "./money";

/**
 * Weighted-average cost basis accounting for the simulated trading desk.
 * `quantity` is a plain number (shares, can be fractional) — this is the
 * one place in the app where a "how much" isn't money, so it doesn't go
 * through the Agorot primitives; see PortfolioHolding's schema comment.
 */
export type HoldingPosition = {
  quantity: number;
  totalCostBasis: Agorot;
};

/** A BUY simply adds shares and their cost to the position — no averaging math needed on the way in. */
export function applyBuy(position: HoldingPosition, quantity: number, totalCost: Agorot): HoldingPosition {
  if (quantity <= 0) {
    throw new RangeError(`BUY quantity must be positive, received ${quantity}`);
  }
  return {
    quantity: position.quantity + quantity,
    totalCostBasis: addAgorot(position.totalCostBasis, totalCost),
  };
}

export type SellResult = {
  position: HoldingPosition;
  proceeds: Agorot;
  realizedPnl: Agorot;
};

/**
 * A SELL realizes gain/loss against the position's weighted-average cost
 * per share, then proportionally reduces both quantity and cost basis —
 * the standard weighted-average-cost accounting method (as opposed to
 * FIFO/LIFO lot tracking, which this app doesn't do).
 */
export function applySell(position: HoldingPosition, quantity: number, pricePerShare: Agorot): SellResult {
  if (quantity <= 0) {
    throw new RangeError(`SELL quantity must be positive, received ${quantity}`);
  }
  if (quantity > position.quantity) {
    throw new RangeError(`Cannot sell ${quantity} shares — only ${position.quantity} held`);
  }

  const avgCostPerShare = position.totalCostBasis / position.quantity;
  const costBasisSold = agorot(Math.round(avgCostPerShare * quantity));
  const proceeds = multiplyAgorot(pricePerShare, quantity);
  const realizedPnl = subtractAgorot(proceeds, costBasisSold);

  const remainingQuantity = position.quantity - quantity;
  const remainingCostBasis =
    remainingQuantity === 0 ? agorot(0) : subtractAgorot(position.totalCostBasis, costBasisSold);

  return {
    position: { quantity: remainingQuantity, totalCostBasis: remainingCostBasis },
    proceeds,
    realizedPnl,
  };
}

/** Current market value minus cost basis — a live, "derived truth" figure, never stored. */
export function unrealizedPnl(position: HoldingPosition, currentPricePerShare: Agorot): Agorot {
  const currentValue = multiplyAgorot(currentPricePerShare, position.quantity);
  return subtractAgorot(currentValue, position.totalCostBasis);
}
