import { type Agorot, agorot } from "./money";
import { coefficientOfVariation, mean } from "./stats";

/** At least this many distinct calendar months of occurrences before a merchant is even considered. */
const MIN_DISTINCT_MONTHS = 3;
/** Below this coefficient of variation, amounts are considered "the same charge" rather than coincidentally similar. */
const MAX_COEFFICIENT_OF_VARIATION = 0.15;

export type MerchantOccurrence = {
  amount: Agorot;
  occurredAt: Date;
};

export type RecurringCandidate = {
  merchantKey: string;
  occurrences: readonly MerchantOccurrence[];
};

export type RecurringDetectionResult = {
  merchantKey: string;
  isRecurring: boolean;
  distinctMonths: number;
  coefficientOfVariation: number;
  averageAmount: Agorot;
  /** Average days between consecutive occurrences, or null with fewer than 2 occurrences. */
  averageIntervalDays: number | null;
};

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** Shared with the subscription radar (subscription-radar.ts) — both need "average
 * days between consecutive occurrences" and there's no reason to duplicate it. */
export function averageIntervalDaysBetween(sortedDates: readonly Date[]): number | null {
  if (sortedDates.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < sortedDates.length; i++) {
    const days = (sortedDates[i].getTime() - sortedDates[i - 1].getTime()) / (24 * 60 * 60 * 1000);
    gaps.push(days);
  }
  return mean(gaps);
}

/**
 * The periodicity engine — this is deliberately NOT a keyword list
 * ("looks like a subscription name"). A merchant is flagged recurring
 * purely from its transaction history: occurrences spread across at
 * least 3 distinct calendar months, with a coefficient of variation on
 * the amount below 0.15 (i.e. the charge is essentially the same amount
 * every time, the hallmark of a subscription or fixed bill rather than
 * ordinary variable spending at a frequently-visited merchant).
 */
export function detectRecurring(candidate: RecurringCandidate): RecurringDetectionResult {
  const { occurrences } = candidate;

  const distinctMonths = new Set(occurrences.map((o) => monthKey(o.occurredAt))).size;
  const amounts = occurrences.map((o) => o.amount);
  const cv = amounts.length > 0 ? coefficientOfVariation(amounts) : Infinity;
  const averageAmount = amounts.length > 0 ? agorot(Math.round(mean(amounts))) : agorot(0);

  const sortedDates = [...occurrences].map((o) => o.occurredAt).sort((a, b) => a.getTime() - b.getTime());

  return {
    merchantKey: candidate.merchantKey,
    isRecurring: distinctMonths >= MIN_DISTINCT_MONTHS && cv < MAX_COEFFICIENT_OF_VARIATION,
    distinctMonths,
    coefficientOfVariation: cv,
    averageAmount,
    averageIntervalDays: averageIntervalDaysBetween(sortedDates),
  };
}

/** Groups flat transaction-like records by merchant key — the shape `detectRecurring` expects. */
export function groupByMerchant(
  transactions: readonly { merchantKey: string; amount: Agorot; occurredAt: Date }[],
): RecurringCandidate[] {
  const byMerchant = new Map<string, MerchantOccurrence[]>();
  for (const { merchantKey, amount, occurredAt } of transactions) {
    const existing = byMerchant.get(merchantKey) ?? [];
    existing.push({ amount, occurredAt });
    byMerchant.set(merchantKey, existing);
  }
  return [...byMerchant.entries()].map(([merchantKey, occurrences]) => ({ merchantKey, occurrences }));
}

/** Convenience wrapper: groups by merchant, detects, and returns only the merchants flagged recurring. */
export function findRecurringMerchants(
  transactions: readonly { merchantKey: string; amount: Agorot; occurredAt: Date }[],
): RecurringDetectionResult[] {
  return groupByMerchant(transactions)
    .map(detectRecurring)
    .filter((result) => result.isRecurring);
}
