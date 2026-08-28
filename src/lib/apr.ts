/**
 * Interest-rate primitives — the single source of truth for the
 * "APR is stored in basis points" law. 1 basis point = 0.01%, so
 * 7.25% APR is stored as the integer 725.
 */

import { type Agorot, multiplyAgorot } from "./money";

const brand = Symbol("BasisPoints");

export type BasisPoints = number & { readonly [brand]: true };

/** Smart constructor — the only way to produce a `BasisPoints` from a raw number. */
export function bps(value: number): BasisPoints {
  if (!Number.isInteger(value)) {
    throw new RangeError(`Basis points must be an integer, received ${value}`);
  }
  return value as BasisPoints;
}

/** 725 bps -> 0.0725 */
export function bpsToDecimalRate(value: BasisPoints): number {
  return value / 10_000;
}

/** 0.0725 -> 725 bps, rounded to the nearest whole basis point. */
export function decimalRateToBps(rate: number): BasisPoints {
  if (!Number.isFinite(rate)) {
    throw new RangeError(`Rate must be finite, received ${rate}`);
  }
  return bps(Math.round(rate * 10_000));
}

/** 725 bps -> "7.25%" */
export function formatBpsAsPercent(value: BasisPoints, fractionDigits = 2): string {
  const percent = value / 100;
  return `${percent.toFixed(fractionDigits)}%`;
}

/** Nominal-APR convention: monthly periodic rate is simply APR / 12. */
export function annualBpsToMonthlyRate(value: BasisPoints): number {
  return bpsToDecimalRate(value) / 12;
}

/**
 * Interest accrued on `principal` at annual rate `rateBps` over one period
 * that is `periodsPerYear` fractions of a year (default: monthly),
 * rounded to the nearest whole agorot.
 */
export function accrueInterest(
  principal: Agorot,
  rateBps: BasisPoints,
  periodsPerYear = 12,
): Agorot {
  const periodicRate = bpsToDecimalRate(rateBps) / periodsPerYear;
  return multiplyAgorot(principal, periodicRate);
}
