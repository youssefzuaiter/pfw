import { addAgorot, agorot, multiplyAgorot, subtractAgorot, type Agorot } from "./money";
import {
  addNativeAmounts,
  multiplyNativeAmount,
  nativeAmount,
  subtractNativeAmounts,
  type CurrencyCode,
  type NativeAmount,
} from "./currency";

/**
 * Weighted-average cost basis accounting for the simulated trading desk.
 * `quantity` is a plain number (shares, can be fractional) — this is the
 * one place in the app where a "how much" isn't money, so it doesn't go
 * through the Agorot primitives; see PortfolioHolding's schema comment.
 *
 * Every base-currency (`Agorot`) figure here has a parallel native-
 * currency (`NativeAmount`) figure — equities trade natively in USD
 * (`currency`), and the ILS figures are that native fact converted once
 * at execution time (AGENTS.md §3k). Callers are responsible for
 * supplying both from the same underlying price/rate — this module never
 * converts between them itself, it only keeps the two ledgers (native and
 * base) moving in lockstep through buys, sells, and valuation.
 */
export type HoldingPosition = {
  quantity: number;
  currency: CurrencyCode;
  totalCostBasis: Agorot;
  nativeCostBasis: NativeAmount;
};

/** A BUY simply adds shares and their cost to the position — no averaging math needed on the way in. */
export function applyBuy(
  position: HoldingPosition,
  quantity: number,
  totalCost: Agorot,
  nativeTotalCost: NativeAmount,
): HoldingPosition {
  if (quantity <= 0) {
    throw new RangeError(`BUY quantity must be positive, received ${quantity}`);
  }
  return {
    ...position,
    quantity: position.quantity + quantity,
    totalCostBasis: addAgorot(position.totalCostBasis, totalCost),
    nativeCostBasis: addNativeAmounts(position.nativeCostBasis, nativeTotalCost),
  };
}

export type SellResult = {
  position: HoldingPosition;
  proceeds: Agorot;
  nativeProceeds: NativeAmount;
  realizedPnl: Agorot;
  nativeRealizedPnl: NativeAmount;
};

/**
 * A SELL realizes gain/loss against the position's weighted-average cost
 * per share, then proportionally reduces both quantity and cost basis —
 * the standard weighted-average-cost accounting method (as opposed to
 * FIFO/LIFO lot tracking, which this app doesn't do) — computed
 * identically and independently for the native and base-currency ledgers.
 */
export function applySell(
  position: HoldingPosition,
  quantity: number,
  pricePerShare: Agorot,
  nativePricePerShare: NativeAmount,
): SellResult {
  if (quantity <= 0) {
    throw new RangeError(`SELL quantity must be positive, received ${quantity}`);
  }
  if (quantity > position.quantity) {
    throw new RangeError(`Cannot sell ${quantity} shares — only ${position.quantity} held`);
  }

  const avgCostPerShare = position.totalCostBasis / position.quantity;
  const costBasisSold = agorot(Math.round(avgCostPerShare * quantity));
  const avgNativeCostPerShare = position.nativeCostBasis / position.quantity;
  const nativeCostBasisSold = nativeAmount(Math.round(avgNativeCostPerShare * quantity));

  const proceeds = multiplyAgorot(pricePerShare, quantity);
  const nativeProceeds = multiplyNativeAmount(nativePricePerShare, quantity);

  const realizedPnl = subtractAgorot(proceeds, costBasisSold);
  const nativeRealizedPnl = subtractNativeAmounts(nativeProceeds, nativeCostBasisSold);

  const remainingQuantity = position.quantity - quantity;
  const remainingCostBasis =
    remainingQuantity === 0 ? agorot(0) : subtractAgorot(position.totalCostBasis, costBasisSold);
  const remainingNativeCostBasis =
    remainingQuantity === 0 ? nativeAmount(0) : subtractNativeAmounts(position.nativeCostBasis, nativeCostBasisSold);

  return {
    position: {
      ...position,
      quantity: remainingQuantity,
      totalCostBasis: remainingCostBasis,
      nativeCostBasis: remainingNativeCostBasis,
    },
    proceeds,
    nativeProceeds,
    realizedPnl,
    nativeRealizedPnl,
  };
}

export type UnrealizedPnlResult = {
  pnl: Agorot;
  nativePnl: NativeAmount;
};

/** Current market value minus cost basis — a live, "derived truth" figure, never stored, in both currencies. */
export function unrealizedPnl(
  position: HoldingPosition,
  currentPricePerShare: Agorot,
  currentNativePricePerShare: NativeAmount,
): UnrealizedPnlResult {
  const currentValue = multiplyAgorot(currentPricePerShare, position.quantity);
  const nativeCurrentValue = multiplyNativeAmount(currentNativePricePerShare, position.quantity);
  return {
    pnl: subtractAgorot(currentValue, position.totalCostBasis),
    nativePnl: subtractNativeAmounts(nativeCurrentValue, position.nativeCostBasis),
  };
}
