/**
 * Manual asset valuation staleness (spec: "valuation freshness timestamps
 * (Fresh/Aging/Stale)"). Always derived from `valuedAt` at read time —
 * never stored (the "derived truth" law): a stored freshness label would
 * silently go wrong the moment time passes without the row being touched.
 */

export type ValuationFreshness = "fresh" | "aging" | "stale";

const FRESH_MAX_DAYS = 30;
const AGING_MAX_DAYS = 90;

export function deriveValuationFreshness(valuedAt: Date, asOf: Date = new Date()): ValuationFreshness {
  const days = (asOf.getTime() - valuedAt.getTime()) / (24 * 60 * 60 * 1000);
  if (days <= FRESH_MAX_DAYS) return "fresh";
  if (days <= AGING_MAX_DAYS) return "aging";
  return "stale";
}
