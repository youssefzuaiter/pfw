import { describe, expect, it } from "vitest";
import { nativeAmount } from "./currency";
import {
  analyzeSubscription,
  calculateCashDrag,
  classifyCadence,
  clusterMerchantsByFuzzyMatch,
  detectPossibleFreeTrials,
  levenshteinDistance,
  normalizeMerchantForFuzzyMatch,
  runSubscriptionRadar,
  segmentByPrice,
  similarityRatio,
  type SubscriptionOccurrence,
} from "./subscription-radar";

const DAY_MS = 24 * 60 * 60 * 1000;
// Anchored to the real `new Date()` — matching every function under test's own
// default `asOf` — rather than a fixed reference date, so tests never depend
// on subtracting from one "now" while the code being tested measures against
// another.
function daysAgo(days: number, from: Date = new Date()): Date {
  return new Date(from.getTime() - days * DAY_MS);
}

describe("levenshteinDistance / similarityRatio", () => {
  it("is zero for identical strings", () => {
    expect(levenshteinDistance("netflix", "netflix")).toBe(0);
    expect(similarityRatio("netflix", "netflix")).toBe(1);
  });

  it("treats two empty strings as identical", () => {
    expect(levenshteinDistance("", "")).toBe(0);
    expect(similarityRatio("", "")).toBe(1);
  });

  it("computes the correct distance for a single substitution", () => {
    expect(levenshteinDistance("netflix", "netflex")).toBe(1);
  });

  it("is low similarity for completely different strings", () => {
    expect(similarityRatio("netflix", "electric company")).toBeLessThan(0.3);
  });
});

describe("normalizeMerchantForFuzzyMatch", () => {
  it("strips a leading payment-processor prefix", () => {
    expect(normalizeMerchantForFuzzyMatch("SQ *Coffee Shop")).toBe("coffee shop");
    expect(normalizeMerchantForFuzzyMatch("TST*Pizza Place")).toBe("pizza place");
  });

  it("strips trailing transaction-id-looking digit runs", () => {
    expect(normalizeMerchantForFuzzyMatch("Netflix.com 88291047")).toBe("netflix.com");
  });

  it("collapses whitespace and lowercases", () => {
    expect(normalizeMerchantForFuzzyMatch("  Spotify   USA  ")).toBe("spotify usa");
  });
});

describe("clusterMerchantsByFuzzyMatch", () => {
  it("merges merchant strings that differ only by a trailing transaction-id suffix into one cluster", () => {
    const clusters = clusterMerchantsByFuzzyMatch([
      { merchantKey: "netflix.com 88291047", displayName: "Netflix.com 88291047", occurrenceCount: 3 },
      { merchantKey: "netflix.com 91847223", displayName: "Netflix.com 91847223", occurrenceCount: 1 },
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].memberMerchantKeys).toContain("netflix.com 88291047");
    expect(clusters[0].memberMerchantKeys).toContain("netflix.com 91847223");
  });

  it("picks the highest-occurrence-count member as canonical", () => {
    const clusters = clusterMerchantsByFuzzyMatch([
      { merchantKey: "netflix.com 91847223", displayName: "Netflix.com 91847223", occurrenceCount: 1 },
      { merchantKey: "netflix.com 88291047", displayName: "Netflix.com 88291047", occurrenceCount: 5 },
    ]);
    expect(clusters[0].canonicalMerchantKey).toBe("netflix.com 88291047");
  });

  it("keeps genuinely different merchants in separate clusters", () => {
    const clusters = clusterMerchantsByFuzzyMatch([
      { merchantKey: "netflix", displayName: "Netflix", occurrenceCount: 4 },
      { merchantKey: "spotify", displayName: "Spotify", occurrenceCount: 4 },
    ]);
    expect(clusters).toHaveLength(2);
  });
});

describe("classifyCadence", () => {
  it("classifies each cadence boundary correctly", () => {
    expect(classifyCadence(7)).toBe("weekly");
    expect(classifyCadence(30)).toBe("monthly");
    expect(classifyCadence(90)).toBe("quarterly");
    expect(classifyCadence(365)).toBe("annual");
  });

  it("returns null for an interval that fits no recognized cadence (irregular billing)", () => {
    expect(classifyCadence(17)).toBeNull(); // between weekly and monthly
    expect(classifyCadence(150)).toBeNull(); // between quarterly and annual
  });

  it("returns null for a null interval (fewer than 2 occurrences)", () => {
    expect(classifyCadence(null)).toBeNull();
  });
});

describe("segmentByPrice", () => {
  it("is a single segment when the price never changes", () => {
    const occurrences = [0, 1, 2, 3].map((i) => ({
      nativeAmount: nativeAmount(-999),
      occurredAt: daysAgo((3 - i) * 30),
    }));
    const segments = segmentByPrice(occurrences);
    expect(segments).toHaveLength(1);
    expect(segments[0].occurrenceCount).toBe(4);
  });

  it("splits into two segments at a genuine price hike", () => {
    const occurrences = [
      { nativeAmount: nativeAmount(-999), occurredAt: daysAgo(90) },
      { nativeAmount: nativeAmount(-999), occurredAt: daysAgo(60) },
      { nativeAmount: nativeAmount(-1299), occurredAt: daysAgo(30) },
      { nativeAmount: nativeAmount(-1299), occurredAt: daysAgo(0) },
    ];
    const segments = segmentByPrice(occurrences);
    expect(segments).toHaveLength(2);
    expect(segments[0].nativeAmount).toBe(-999);
    expect(segments[1].nativeAmount).toBe(-1299);
  });

  it("absorbs sub-tolerance rounding noise into a single segment", () => {
    // Within 5% of each other — not a real price change.
    const occurrences = [
      { nativeAmount: nativeAmount(-1000), occurredAt: daysAgo(60) },
      { nativeAmount: nativeAmount(-1002), occurredAt: daysAgo(30) },
      { nativeAmount: nativeAmount(-998), occurredAt: daysAgo(0) },
    ];
    expect(segmentByPrice(occurrences)).toHaveLength(1);
  });

  it("returns an empty array for no occurrences", () => {
    expect(segmentByPrice([])).toEqual([]);
  });
});

function occurrence(overrides: Partial<SubscriptionOccurrence>): SubscriptionOccurrence {
  return {
    merchantKey: "netflix",
    displayName: "Netflix",
    currency: "ILS",
    nativeAmount: nativeAmount(-3990),
    occurredAt: daysAgo(0),
    ...overrides,
  };
}

describe("analyzeSubscription", () => {
  it("flags a steady monthly charge as recurring with no price hike", () => {
    const occurrences = [90, 60, 30, 0].map((d) => occurrence({ occurredAt: daysAgo(d) }));
    const result = analyzeSubscription(occurrences);
    expect(result.isRecurring).toBe(true);
    expect(result.cadence).toBe("monthly");
    expect(result.priceHike).toBeNull();
    expect(result.currentNativeAmount).toBe(-3990);
  });

  it("detects a price hike and reports the correct before/after amounts and date", () => {
    const hikeDate = daysAgo(30);
    const occurrences = [
      occurrence({ occurredAt: daysAgo(90), nativeAmount: nativeAmount(-3990) }),
      occurrence({ occurredAt: daysAgo(60), nativeAmount: nativeAmount(-3990) }),
      occurrence({ occurredAt: hikeDate, nativeAmount: nativeAmount(-4990) }),
      occurrence({ occurredAt: daysAgo(0), nativeAmount: nativeAmount(-4990) }),
    ];
    const result = analyzeSubscription(occurrences);
    expect(result.isRecurring).toBe(true);
    expect(result.priceHike).not.toBeNull();
    expect(result.priceHike?.previousNativeAmount).toBe(-3990);
    expect(result.priceHike?.newNativeAmount).toBe(-4990);
    expect(result.priceHike?.changeDate).toEqual(hikeDate);
    expect(result.priceHike?.percentChange).toBeCloseTo((4990 - 3990) / 3990, 5);
  });

  it("does not flag a price decrease as a hike", () => {
    const occurrences = [
      occurrence({ occurredAt: daysAgo(90), nativeAmount: nativeAmount(-4990) }),
      occurrence({ occurredAt: daysAgo(60), nativeAmount: nativeAmount(-4990) }),
      occurrence({ occurredAt: daysAgo(30), nativeAmount: nativeAmount(-2990) }),
      occurrence({ occurredAt: daysAgo(0), nativeAmount: nativeAmount(-2990) }),
    ];
    expect(analyzeSubscription(occurrences).priceHike).toBeNull();
  });

  it("is NOT recurring with too few occurrences for its cadence", () => {
    const occurrences = [30, 0].map((d) => occurrence({ occurredAt: daysAgo(d) })); // monthly needs 3+
    expect(analyzeSubscription(occurrences).isRecurring).toBe(false);
  });

  it("is NOT recurring with irregular billing dates that fit no cadence", () => {
    // Gaps of 80/20/80/20 days average to exactly 50 — squarely in the dead
    // zone between "monthly" (25-35) and "quarterly" (80-100).
    const occurrences = [200, 180, 100, 80, 0].map((d) => occurrence({ occurredAt: daysAgo(d) }));
    const result = analyzeSubscription(occurrences);
    expect(result.cadence).toBeNull();
    expect(result.isRecurring).toBe(false);
  });

  it("is NOT recurring with too many distinct price levels (ordinary variable spending, not a subscription)", () => {
    const occurrences = [120, 90, 60, 30, 0].map((d, i) =>
      occurrence({ occurredAt: daysAgo(d), nativeAmount: nativeAmount(-1000 * (i + 1)) }),
    );
    expect(analyzeSubscription(occurrences).isRecurring).toBe(false);
  });

  it("currency-conversion edge case: a constant native-currency price is correctly recognized as recurring with no false price hike, regardless of what its ILS-converted value would have done", () => {
    // A USD subscription billed at a constant $9.99 (999 cents) every month.
    // If this were analyzed on the ILS-converted `amount` column instead of
    // `nativeAmount`, ordinary exchange-rate movement between billing
    // cycles could make the ILS figure drift well outside a 5% tolerance
    // even though nothing about the subscription's actual price changed —
    // this engine never sees that column at all, only `nativeAmount`, so
    // that failure mode structurally cannot occur here.
    const occurrences = [90, 60, 30, 0].map((d) =>
      occurrence({ occurredAt: daysAgo(d), currency: "USD", nativeAmount: nativeAmount(-999) }),
    );
    const result = analyzeSubscription(occurrences);
    expect(result.isRecurring).toBe(true);
    expect(result.priceHike).toBeNull();
    expect(result.currency).toBe("USD");
  });

  it("computes nextExpectedDate as lastSeenAt plus the average interval, only when recurring", () => {
    const occurrences = [60, 30, 0].map((d) => occurrence({ occurredAt: daysAgo(d) }));
    const result = analyzeSubscription(occurrences);
    expect(result.nextExpectedDate).not.toBeNull();
    expect(result.nextExpectedDate!.getTime()).toBeGreaterThan(result.lastSeenAt.getTime());
  });

  it("throws on an empty occurrence list", () => {
    expect(() => analyzeSubscription([])).toThrow(RangeError);
  });
});

describe("detectPossibleFreeTrials", () => {
  function candidate(daysSince: number, nativeAmountValue = -500) {
    return {
      merchantKey: "trial-service",
      displayName: "Trial Service",
      occurrences: [occurrence({ occurredAt: daysAgo(daysSince), nativeAmount: nativeAmount(nativeAmountValue) })],
    };
  }

  it("flags a single small recent charge within the trial window", () => {
    const result = detectPossibleFreeTrials([candidate(30)]);
    expect(result).toHaveLength(1);
    expect(result[0].merchantKey).toBe("trial-service");
  });

  it("does not flag a charge that's too recent", () => {
    expect(detectPossibleFreeTrials([candidate(5)])).toHaveLength(0);
  });

  it("does not flag a charge that's too old", () => {
    expect(detectPossibleFreeTrials([candidate(90)])).toHaveLength(0);
  });

  it("does not flag a charge above the small-amount ceiling", () => {
    expect(detectPossibleFreeTrials([candidate(30, -50_00)])).toHaveLength(0);
  });

  it("does not flag income", () => {
    expect(detectPossibleFreeTrials([candidate(30, 500)])).toHaveLength(0);
  });

  it("does not flag a merchant with more than one occurrence", () => {
    const twoOccurrences = {
      merchantKey: "not-a-trial",
      displayName: "Not A Trial",
      occurrences: [occurrence({ occurredAt: daysAgo(30) }), occurrence({ occurredAt: daysAgo(60) })],
    };
    expect(detectPossibleFreeTrials([twoOccurrences])).toHaveLength(0);
  });
});

describe("calculateCashDrag", () => {
  const rateTable = { ILS: 1, USD: 3.7, EUR: 4.0, GBP: 4.7 };

  it("sums a single ILS monthly subscription to itself, annualized by 12", () => {
    const result = calculateCashDrag(
      [{ currency: "ILS", currentNativeAmount: nativeAmount(-1000), cadence: "monthly" }],
      rateTable,
    );
    expect(result.monthlyAgorot).toBe(1000);
    expect(result.annualAgorot).toBe(12_000);
  });

  it("normalizes a weekly and an annual subscription onto the same monthly basis", () => {
    const result = calculateCashDrag(
      [
        { currency: "ILS", currentNativeAmount: nativeAmount(-100), cadence: "weekly" }, // 100*52 = 5200/yr
        { currency: "ILS", currentNativeAmount: nativeAmount(-1200), cadence: "annual" }, // 1200/yr
      ],
      rateTable,
    );
    expect(result.annualAgorot).toBe(5_200 + 1_200);
  });

  it("converts a foreign-currency subscription at the given rate", () => {
    const result = calculateCashDrag(
      [{ currency: "USD", currentNativeAmount: nativeAmount(-1000), cadence: "monthly" }], // $10.00/mo
      rateTable,
    );
    expect(result.monthlyAgorot).toBe(Math.round(1000 * 3.7));
  });

  it("ignores a subscription with a null cadence defensively", () => {
    const result = calculateCashDrag(
      [{ currency: "ILS", currentNativeAmount: nativeAmount(-1000), cadence: null }],
      rateTable,
    );
    expect(result.monthlyAgorot).toBe(0);
    expect(result.annualAgorot).toBe(0);
  });
});

describe("runSubscriptionRadar", () => {
  it("merges fuzzy-matched merchant variants into one subscription", () => {
    // Same real merchant, billed with a different trailing transaction-id
    // suffix each cycle — the realistic case this feature exists for.
    const transactions: SubscriptionOccurrence[] = [
      occurrence({ merchantKey: "netflix.com 11111111", displayName: "Netflix.com 11111111", occurredAt: daysAgo(90) }),
      occurrence({ merchantKey: "netflix.com 22222222", displayName: "Netflix.com 22222222", occurredAt: daysAgo(60) }),
      occurrence({ merchantKey: "netflix.com 33333333", displayName: "Netflix.com 33333333", occurredAt: daysAgo(30) }),
      occurrence({ merchantKey: "netflix.com 44444444", displayName: "Netflix.com 44444444", occurredAt: daysAgo(0) }),
    ];
    const result = runSubscriptionRadar(transactions);
    expect(result.subscriptions).toHaveLength(1);
    expect(result.subscriptions[0].occurrenceCount).toBe(4);
  });

  it("excludes income entirely", () => {
    const transactions: SubscriptionOccurrence[] = [90, 60, 30, 0].map((d) =>
      occurrence({ merchantKey: "salary", displayName: "Employer", occurredAt: daysAgo(d), nativeAmount: nativeAmount(15_000_00) }),
    );
    const result = runSubscriptionRadar(transactions);
    expect(result.subscriptions).toHaveLength(0);
    expect(result.possibleFreeTrials).toHaveLength(0);
  });

  it("routes a single recent small charge to possibleFreeTrials, not subscriptions", () => {
    const transactions: SubscriptionOccurrence[] = [
      occurrence({ merchantKey: "new-service", displayName: "New Service", occurredAt: daysAgo(25), nativeAmount: nativeAmount(-199) }),
    ];
    const result = runSubscriptionRadar(transactions);
    expect(result.subscriptions).toHaveLength(0);
    expect(result.possibleFreeTrials).toHaveLength(1);
  });

  it("does not merge the same merchant name billed in two different currencies", () => {
    const transactions: SubscriptionOccurrence[] = [
      ...[90, 60, 30, 0].map((d) => occurrence({ currency: "ILS" as const, occurredAt: daysAgo(d) })),
      ...[90, 60, 30, 0].map((d) => occurrence({ currency: "USD" as const, occurredAt: daysAgo(d), nativeAmount: nativeAmount(-999) })),
    ];
    const result = runSubscriptionRadar(transactions);
    expect(result.subscriptions).toHaveLength(2);
    expect(new Set(result.subscriptions.map((s) => s.currency))).toEqual(new Set(["ILS", "USD"]));
  });

  it("does not flag ordinary irregular spending at a frequently-visited merchant as either recurring or a free trial", () => {
    const amounts = [-1200, -3400, -800, -5600, -2100, -900];
    const transactions: SubscriptionOccurrence[] = amounts.map((amount, i) =>
      occurrence({ merchantKey: "grocery-store", displayName: "Grocery Store", occurredAt: daysAgo(i * 11), nativeAmount: nativeAmount(amount) }),
    );
    const result = runSubscriptionRadar(transactions);
    expect(result.subscriptions).toHaveLength(0);
    expect(result.possibleFreeTrials).toHaveLength(0);
  });
});
