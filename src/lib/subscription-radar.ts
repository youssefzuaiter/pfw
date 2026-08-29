import { agorot, type Agorot } from "./money";
import { nativeAmount, type CurrencyCode, type NativeAmount } from "./currency";
import { convertNativeAmountToAgorot } from "./exchange-rate";
import { averageIntervalDaysBetween } from "./recurring-detection";
import { mean } from "./stats";

/**
 * Subscription & Recurring Expense Intelligence Radar (AGENTS.md §3p) —
 * pure engine over already-fetched data, same `src/lib/` convention as
 * every other engine (§3b). Deliberately separate from, not a rewrite
 * of, `recurring-detection.ts`'s spec-defined periodicity engine (3+
 * distinct months, coefficient of variation < 0.15) — that engine backs
 * the cash-flow forecast and the "recurring charge detected" insight
 * today and stays exactly as spec'd. This module adds three things that
 * engine was never meant to do: fuzzy merchant-name matching (its
 * `groupByMerchant` is an exact string match), a price-hike-aware
 * recurring check that survives a subscription that changed price once
 * or twice instead of failing a whole-history CV check, and stateful
 * per-merchant cancel/review tracking (src/server/dal/subscriptions.ts).
 */

// === Fuzzy merchant matching ================================================

/**
 * Strips generic payment-processor formatting noise — a leading
 * processor prefix ("SQ *", "TST*") and trailing transaction-ID-looking
 * digit runs — NOT merchant-brand-specific keywords. This is a text-
 * normalization step for telling "the same real-world merchant, billed
 * under a slightly different descriptor string each cycle" apart from
 * "two different merchants," not a decision about what counts as
 * recurring (that's still purely amount+frequency based, per law #4's
 * neighboring "not a keyword list" rule for the periodicity engine).
 */
export function normalizeMerchantForFuzzyMatch(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^[a-z]{2,5}\s*\*\s*/i, "")
    .replace(/[*#]/g, " ")
    .replace(/\b\d{4,}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Classic edit-distance dynamic program — hand-written rather than a dependency,
 * matching this project's habit of owning small, well-understood algorithms
 * directly (the CSV tokenizer, the seeded RNG, the Monte Carlo engine's Box-Muller). */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previousRow = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const currentRow = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      currentRow.push(Math.min(currentRow[j - 1] + 1, previousRow[j] + 1, previousRow[j - 1] + substitutionCost));
    }
    previousRow = currentRow;
  }
  return previousRow[b.length];
}

/** 1 = identical, 0 = completely different; two empty strings are treated as identical. */
export function similarityRatio(a: string, b: string): number {
  const maxLength = Math.max(a.length, b.length);
  if (maxLength === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLength;
}

export type FuzzyMerchantCluster = {
  canonicalMerchantKey: string;
  canonicalDisplayName: string;
  memberMerchantKeys: readonly string[];
};

const DEFAULT_SIMILARITY_THRESHOLD = 0.82;

/**
 * Greedily clusters merchant strings by fuzzy similarity of their
 * normalized form. The canonical key/name for a cluster is whichever
 * raw `merchantKey` has the most occurrences (ties broken by iteration
 * order over the input) — this needs to be a stable, deterministic
 * choice, not "some member of the cluster," because it's the identity
 * `SubscriptionTracking` rows and the UI are keyed against.
 */
export function clusterMerchantsByFuzzyMatch(
  merchants: readonly { merchantKey: string; displayName: string; occurrenceCount: number }[],
  threshold = DEFAULT_SIMILARITY_THRESHOLD,
): FuzzyMerchantCluster[] {
  type WorkingCluster = { normalizedRepresentative: string; members: (typeof merchants)[number][] };
  const clusters: WorkingCluster[] = [];

  // Largest-occurrence-count first, so a cluster's first (representative)
  // member is already likely to end up canonical, and later merges
  // compare against the most representative string seen so far.
  const sorted = [...merchants].sort((a, b) => b.occurrenceCount - a.occurrenceCount);

  for (const merchant of sorted) {
    const normalized = normalizeMerchantForFuzzyMatch(merchant.displayName);
    const match = clusters.find(
      (cluster) => similarityRatio(cluster.normalizedRepresentative, normalized) >= threshold,
    );
    if (match) {
      match.members.push(merchant);
    } else {
      clusters.push({ normalizedRepresentative: normalized, members: [merchant] });
    }
  }

  return clusters.map((cluster) => {
    const canonical = [...cluster.members].sort((a, b) => b.occurrenceCount - a.occurrenceCount)[0];
    return {
      canonicalMerchantKey: canonical.merchantKey,
      canonicalDisplayName: canonical.displayName,
      memberMerchantKeys: cluster.members.map((m) => m.merchantKey),
    };
  });
}

// === Cadence classification =================================================

export type SubscriptionCadence = "weekly" | "monthly" | "quarterly" | "annual";

const CADENCE_INTERVAL_RANGES_DAYS: Record<SubscriptionCadence, readonly [number, number]> = {
  weekly: [5, 10],
  monthly: [25, 35],
  quarterly: [80, 100],
  annual: [340, 390],
};

/**
 * How many occurrences are required before each cadence counts as
 * "proven recurring," not merely coincidental. Deliberately NOT a flat
 * "3+" for every cadence, unlike the periodicity engine's month-based
 * rule: demanding 3 occurrences of an annual subscription would need 3
 * years of history before ever flagging it, which is not a realistic
 * bar for a personal-finance app most people use for months, not years.
 */
const MIN_OCCURRENCES_BY_CADENCE: Record<SubscriptionCadence, number> = {
  weekly: 4,
  monthly: 3,
  quarterly: 2,
  annual: 2,
};

/** How many times a year each cadence bills — used to normalize cash drag to monthly/annual figures. */
const BILLS_PER_YEAR: Record<SubscriptionCadence, number> = {
  weekly: 52,
  monthly: 12,
  quarterly: 4,
  annual: 1,
};

export function classifyCadence(averageIntervalDays: number | null): SubscriptionCadence | null {
  if (averageIntervalDays === null) return null;
  for (const [cadence, [min, max]] of Object.entries(CADENCE_INTERVAL_RANGES_DAYS) as [
    SubscriptionCadence,
    [number, number],
  ][]) {
    if (averageIntervalDays >= min && averageIntervalDays <= max) return cadence;
  }
  return null;
}

// === Price-history segmentation (the price-hike-aware part) ================

export type PriceSegment = {
  /** Signed, same sign convention as the input occurrences (negative for an expense). */
  nativeAmount: NativeAmount;
  startDate: Date;
  endDate: Date;
  occurrenceCount: number;
};

/** 5% relative tolerance — small enough to catch a real price change, large enough to
 * absorb ordinary rounding noise. Applied to *native* amounts, never the ILS-converted
 * `amount` column: a foreign-currency subscription's native price is what the merchant
 * actually charges, unaffected by exchange-rate movement between billing cycles, which
 * is exactly what keeps FX drift from ever being mistaken for a price hike here. */
const PRICE_CHANGE_TOLERANCE = 0.05;

/** Only exists to satisfy segmentByPrice's tolerance check against a same-sign, same-currency series. */
function magnitudeOf(amount: NativeAmount): number {
  return Math.abs(amount);
}

/**
 * Splits a chronologically-sorted occurrence list into contiguous runs
 * of "the same price" — each run's own running average is the
 * comparison baseline, not the very first occurrence, so a *gradual*
 * drift within tolerance doesn't accumulate into a false hike, while a
 * genuine step change starts a new segment immediately.
 */
export function segmentByPrice(
  occurrences: readonly { nativeAmount: NativeAmount; occurredAt: Date }[],
): PriceSegment[] {
  if (occurrences.length === 0) return [];
  const sorted = [...occurrences].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  const working: { amounts: number[]; startDate: Date; endDate: Date }[] = [];
  for (const occurrence of sorted) {
    const current = working.at(-1);
    const runningAverageMagnitude = current ? magnitudeOf(nativeAmount(Math.round(mean(current.amounts)))) : null;
    const withinTolerance =
      runningAverageMagnitude !== null &&
      Math.abs(magnitudeOf(occurrence.nativeAmount) - runningAverageMagnitude) <=
        runningAverageMagnitude * PRICE_CHANGE_TOLERANCE;

    if (current && withinTolerance) {
      current.amounts.push(occurrence.nativeAmount);
      current.endDate = occurrence.occurredAt;
    } else {
      working.push({ amounts: [occurrence.nativeAmount], startDate: occurrence.occurredAt, endDate: occurrence.occurredAt });
    }
  }

  return working.map((segment) => ({
    nativeAmount: nativeAmount(Math.round(mean(segment.amounts))),
    startDate: segment.startDate,
    endDate: segment.endDate,
    occurrenceCount: segment.amounts.length,
  }));
}

// === Per-merchant subscription analysis =====================================

export type SubscriptionOccurrence = {
  merchantKey: string;
  displayName: string;
  currency: CurrencyCode;
  /** Signed — negative for an expense. Callers must pass a single currency's occurrences per call. */
  nativeAmount: NativeAmount;
  occurredAt: Date;
};

export type PriceHike = {
  previousNativeAmount: NativeAmount;
  newNativeAmount: NativeAmount;
  changeDate: Date;
  /** e.g. 0.15 for a 15% increase. Always positive — a decrease is not reported as a "hike". */
  percentChange: number;
};

export type SubscriptionAnalysis = {
  merchantKey: string;
  displayName: string;
  currency: CurrencyCode;
  isRecurring: boolean;
  cadence: SubscriptionCadence | null;
  occurrenceCount: number;
  /** The latest price segment's amount — reflects a hike immediately, unlike an all-history average. */
  currentNativeAmount: NativeAmount;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** `lastSeenAt` + the average interval, only when `isRecurring`. */
  nextExpectedDate: Date | null;
  priceHike: PriceHike | null;
};

/** More than this many distinct price levels stops looking like "a subscription that
 * changed price once or twice" and starts looking like ordinary variable spending at a
 * frequently-visited merchant — which is exactly what the periodicity engine's
 * coefficient-of-variation check already excludes for the non-price-aware case. */
const MAX_PRICE_SEGMENTS = 3;

/** Throws on an empty list — same "smart constructor" convention as `money.ts`'s `agorot()`: there's no meaningful analysis of zero occurrences, so this is a caller bug, not a value to represent. */
export function analyzeSubscription(occurrences: readonly SubscriptionOccurrence[]): SubscriptionAnalysis {
  if (occurrences.length === 0) {
    throw new RangeError("Cannot analyze an empty occurrence list");
  }

  const sorted = [...occurrences].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const dates = sorted.map((o) => o.occurredAt);
  const averageIntervalDays = averageIntervalDaysBetween(dates);
  const cadence = classifyCadence(averageIntervalDays);

  const segments = segmentByPrice(sorted.map((o) => ({ nativeAmount: o.nativeAmount, occurredAt: o.occurredAt })));

  const isRecurring =
    cadence !== null &&
    sorted.length >= MIN_OCCURRENCES_BY_CADENCE[cadence] &&
    segments.length > 0 &&
    segments.length <= MAX_PRICE_SEGMENTS;

  const lastSegment = segments[segments.length - 1];
  const secondLastSegment = segments.length >= 2 ? segments[segments.length - 2] : null;

  let priceHike: PriceHike | null = null;
  if (isRecurring && secondLastSegment) {
    const previousMagnitude = magnitudeOf(secondLastSegment.nativeAmount);
    const newMagnitude = magnitudeOf(lastSegment.nativeAmount);
    if (newMagnitude > previousMagnitude) {
      priceHike = {
        previousNativeAmount: secondLastSegment.nativeAmount,
        newNativeAmount: lastSegment.nativeAmount,
        changeDate: lastSegment.startDate,
        percentChange: (newMagnitude - previousMagnitude) / previousMagnitude,
      };
    }
  }

  const lastSeenAt = dates[dates.length - 1];
  const nextExpectedDate =
    isRecurring && averageIntervalDays !== null
      ? new Date(lastSeenAt.getTime() + averageIntervalDays * 24 * 60 * 60 * 1000)
      : null;

  return {
    merchantKey: sorted[0].merchantKey,
    displayName: sorted[0].displayName,
    currency: sorted[0].currency,
    isRecurring,
    cadence,
    occurrenceCount: sorted.length,
    currentNativeAmount: lastSegment.nativeAmount,
    firstSeenAt: dates[0],
    lastSeenAt,
    nextExpectedDate,
    priceHike,
  };
}

// === Forgotten free trials ===================================================

export type PossibleFreeTrial = {
  merchantKey: string;
  displayName: string;
  currency: CurrencyCode;
  nativeAmount: NativeAmount;
  chargedAt: Date;
  daysSinceCharge: number;
};

const FREE_TRIAL_MIN_LOOKBACK_DAYS = 20;
const FREE_TRIAL_MAX_LOOKBACK_DAYS = 45;
/** A common small-charge ceiling for trial-verification/"$0.99 for the first month"
 * patterns — 1000 minor units (₪10 / $10 / €10 / £10), the same 2-decimal minor-unit
 * scale every supported currency shares (currency.ts). */
const FREE_TRIAL_MAX_NATIVE_MINOR_UNITS = 1000;

/**
 * A structural heuristic, not a brand-name keyword list (consistent
 * with the periodicity engine's own "not a keyword list" law): exactly
 * one small expense, recent enough that a monthly-or-shorter
 * subscription would be due to renew again soon — or may already have,
 * unnoticed — but old enough that a same-day accidental duplicate
 * charge isn't mistaken for a trial. Explicitly a speculative signal:
 * "worth checking," never surfaced as a confirmed subscription.
 */
export function detectPossibleFreeTrials(
  candidates: readonly { merchantKey: string; displayName: string; occurrences: readonly SubscriptionOccurrence[] }[],
  asOf: Date = new Date(),
): PossibleFreeTrial[] {
  const results: PossibleFreeTrial[] = [];

  for (const candidate of candidates) {
    if (candidate.occurrences.length !== 1) continue;
    const [occurrence] = candidate.occurrences;
    if (occurrence.nativeAmount >= 0) continue; // expenses only

    const daysSinceCharge = (asOf.getTime() - occurrence.occurredAt.getTime()) / (24 * 60 * 60 * 1000);
    if (daysSinceCharge < FREE_TRIAL_MIN_LOOKBACK_DAYS || daysSinceCharge > FREE_TRIAL_MAX_LOOKBACK_DAYS) continue;
    if (magnitudeOf(occurrence.nativeAmount) > FREE_TRIAL_MAX_NATIVE_MINOR_UNITS) continue;

    results.push({
      merchantKey: candidate.merchantKey,
      displayName: candidate.displayName,
      currency: occurrence.currency,
      nativeAmount: occurrence.nativeAmount,
      chargedAt: occurrence.occurredAt,
      daysSinceCharge: Math.round(daysSinceCharge),
    });
  }

  return results;
}

// === Cash drag ================================================================

export type CashDragSummary = { monthlyAgorot: Agorot; annualAgorot: Agorot };

/**
 * Normalizes every active subscription's *current* price (post-hike, if
 * any) to a monthly and annual ILS figure, converting a foreign-currency
 * subscription at the *latest* synced rate — a deliberately live
 * conversion, not the historical per-transaction rate, since cash drag
 * is meant to answer "what is this costing me now," not "what did each
 * past charge convert to at the time."
 */
export function calculateCashDrag(
  activeSubscriptions: readonly Pick<SubscriptionAnalysis, "currency" | "currentNativeAmount" | "cadence">[],
  rateTable: Readonly<Record<CurrencyCode, number>>,
): CashDragSummary {
  let annualAgorotTotal = 0;
  for (const subscription of activeSubscriptions) {
    if (!subscription.cadence) continue;
    const perOccurrenceAgorot = convertNativeAmountToAgorot(
      nativeAmount(magnitudeOf(subscription.currentNativeAmount)),
      subscription.currency,
      rateTable[subscription.currency],
    );
    annualAgorotTotal += Number(perOccurrenceAgorot) * BILLS_PER_YEAR[subscription.cadence];
  }

  const annualAgorot = agorot(Math.round(annualAgorotTotal));
  const monthlyAgorot = agorot(Math.round(annualAgorotTotal / 12));
  return { monthlyAgorot, annualAgorot };
}

// === Top-level orchestration =================================================

export type SubscriptionRadarResult = {
  subscriptions: SubscriptionAnalysis[];
  possibleFreeTrials: PossibleFreeTrial[];
};

/**
 * The radar's entry point: fuzzy-clusters merchants (scoped per currency
 * — never merges two currencies' billing into one series), analyzes
 * each cluster, and splits the result into confirmed recurring
 * subscriptions vs. single-occurrence "possible free trial" candidates.
 * Only expenses are considered — a recurring salary deposit isn't a
 * subscription (recurring-detection.ts's engine, used for the cash-flow
 * forecast, deliberately includes income; this one doesn't need to).
 */
export function runSubscriptionRadar(
  transactions: readonly SubscriptionOccurrence[],
  asOf: Date = new Date(),
): SubscriptionRadarResult {
  const expenses = transactions.filter((t) => t.nativeAmount < 0);

  const byCurrency = new Map<CurrencyCode, SubscriptionOccurrence[]>();
  for (const transaction of expenses) {
    const list = byCurrency.get(transaction.currency) ?? [];
    list.push(transaction);
    byCurrency.set(transaction.currency, list);
  }

  const subscriptions: SubscriptionAnalysis[] = [];
  const freeTrialCandidates: { merchantKey: string; displayName: string; occurrences: SubscriptionOccurrence[] }[] = [];

  for (const currencyTransactions of byCurrency.values()) {
    const byRawKey = new Map<string, SubscriptionOccurrence[]>();
    for (const transaction of currencyTransactions) {
      const list = byRawKey.get(transaction.merchantKey) ?? [];
      list.push(transaction);
      byRawKey.set(transaction.merchantKey, list);
    }

    const rawMerchants = [...byRawKey.entries()].map(([merchantKey, occurrences]) => ({
      merchantKey,
      displayName: occurrences[0].displayName,
      occurrenceCount: occurrences.length,
    }));

    for (const cluster of clusterMerchantsByFuzzyMatch(rawMerchants)) {
      const memberOccurrences = cluster.memberMerchantKeys
        .flatMap((key) => byRawKey.get(key) ?? [])
        .map((occurrence) => ({
          ...occurrence,
          merchantKey: cluster.canonicalMerchantKey,
          displayName: cluster.canonicalDisplayName,
        }));

      const analysis = analyzeSubscription(memberOccurrences);
      if (analysis.isRecurring) {
        subscriptions.push(analysis);
      } else {
        freeTrialCandidates.push({
          merchantKey: cluster.canonicalMerchantKey,
          displayName: cluster.canonicalDisplayName,
          occurrences: memberOccurrences,
        });
      }
    }
  }

  return {
    subscriptions: subscriptions.sort(
      (a, b) => magnitudeOf(b.currentNativeAmount) - magnitudeOf(a.currentNativeAmount),
    ),
    possibleFreeTrials: detectPossibleFreeTrials(freeTrialCandidates, asOf),
  };
}
