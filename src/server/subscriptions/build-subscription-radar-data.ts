import "server-only";
import { cache } from "react";
import { formatAgorot, type Agorot } from "../../lib/money";
import { formatNativeAmount, nativeAmount } from "../../lib/currency";
import {
  calculateCashDrag,
  runSubscriptionRadar,
  type PossibleFreeTrial,
  type SubscriptionAnalysis,
  type SubscriptionOccurrence,
} from "../../lib/subscription-radar";
import { getLatestRateTable } from "../dal/exchange-rates";
import { getSubscriptionStatuses } from "../dal/subscriptions";
import { getTransactionOccurrencesSince } from "../dal/transactions";

/** How far back the radar looks. Generous relative to what this app's seed
 * data actually spans (a rolling 90-day window, AGENTS.md §3a) — the extra
 * headroom is for a real account's real history, where an annual
 * subscription's 2 occurrences could genuinely be ~365 days apart. */
const LOOKBACK_DAYS = 400;

export type SubscriptionReviewStatus = "ACTIVE" | "REVIEWED" | "CANCELLED";

export type SubscriptionRow = SubscriptionAnalysis & {
  status: SubscriptionReviewStatus;
  formattedCurrentAmount: string;
  formattedPriceHike: { from: string; to: string } | null;
};

export type SubscriptionRadarData = {
  subscriptions: SubscriptionRow[];
  possibleFreeTrials: (ReturnType<typeof buildFreeTrialRow>)[];
  cashDrag: { monthly: string; annual: string };
  /** The same monthly cash-drag total as `cashDrag.monthly`, as a raw `Agorot` rather than a formatted display string — added for the Real-Time Liquidity Runway & Burn-Rate Engine (AGENTS.md §3v), which needs the actual number to compute a burn-rate floor, not text to render. Purely additive; the existing `cashDrag` field and every prior consumer of it are unchanged. */
  cashDragMonthlyAgorot: Agorot;
};

function buildFreeTrialRow(trial: PossibleFreeTrial) {
  return {
    merchantKey: trial.merchantKey,
    displayName: trial.displayName,
    formattedAmount: formatNativeAmount(trial.nativeAmount, trial.currency),
    chargedAt: trial.chargedAt,
    daysSinceCharge: trial.daysSinceCharge,
  };
}

/**
 * Assembles everything `/transactions/subscriptions` renders: runs the
 * radar (src/lib/subscription-radar.ts) over recent transaction history,
 * merges in each merchant's stored review/cancellation status (default
 * ACTIVE for anything never explicitly touched), and totals cash drag
 * across only the still-ACTIVE subscriptions — a cancelled one
 * shouldn't count against "what is this costing me now" even though its
 * transaction history still exists.
 *
 * `cache()`-wrapped for the same request-scoping reason every other
 * `build-*-data.ts` aggregator is (§3c) — per-user financial data, never
 * a cross-request cache.
 */
export const buildSubscriptionRadarData = cache(async function buildSubscriptionRadarData(
  userId: string,
  asOf: Date = new Date(),
): Promise<SubscriptionRadarData> {
  const since = new Date(asOf.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const [occurrenceRows, statuses, rateTable] = await Promise.all([
    getTransactionOccurrencesSince(userId, since),
    getSubscriptionStatuses(userId),
    getLatestRateTable(asOf),
  ]);

  const occurrences: SubscriptionOccurrence[] = occurrenceRows.map((row) => ({
    merchantKey: row.merchantKey,
    displayName: row.displayName,
    currency: row.currency,
    nativeAmount: nativeAmount(Number(row.nativeAmount)),
    occurredAt: row.occurredAt,
  }));

  const radarResult = runSubscriptionRadar(occurrences, asOf);

  const subscriptions: SubscriptionRow[] = radarResult.subscriptions.map((analysis) => {
    const status = statuses.get(analysis.merchantKey) ?? "ACTIVE";
    return {
      ...analysis,
      status,
      formattedCurrentAmount: formatNativeAmount(analysis.currentNativeAmount, analysis.currency),
      formattedPriceHike: analysis.priceHike
        ? {
            from: formatNativeAmount(analysis.priceHike.previousNativeAmount, analysis.currency),
            to: formatNativeAmount(analysis.priceHike.newNativeAmount, analysis.currency),
          }
        : null,
    };
  });

  const activeForCashDrag = subscriptions.filter((s) => s.status !== "CANCELLED");
  const cashDrag = calculateCashDrag(activeForCashDrag, rateTable);

  return {
    subscriptions: subscriptions.sort((a, b) => {
      // Active/reviewed subscriptions first, cancelled ones pushed to the
      // bottom — a cancelled subscription is still worth showing (so a
      // toggle can be undone) but shouldn't compete for attention.
      if (a.status === "CANCELLED" && b.status !== "CANCELLED") return 1;
      if (a.status !== "CANCELLED" && b.status === "CANCELLED") return -1;
      return 0;
    }),
    possibleFreeTrials: radarResult.possibleFreeTrials.map(buildFreeTrialRow),
    cashDrag: { monthly: formatAgorot(cashDrag.monthlyAgorot), annual: formatAgorot(cashDrag.annualAgorot) },
    cashDragMonthlyAgorot: cashDrag.monthlyAgorot,
  };
});
