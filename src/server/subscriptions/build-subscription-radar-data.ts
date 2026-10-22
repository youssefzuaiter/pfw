import "server-only";
import { cache } from "react";
import type { Agorot } from "../../lib/money";
import { getReportingFormatter } from "../reporting/reporting-context";
import { formatNativeAmount, nativeAmount } from "../../lib/currency";
import {
  calculateCashDrag,
  runSubscriptionRadar,
  type PossibleFreeTrial,
  type SubscriptionAnalysis,
  type SubscriptionOccurrence,
} from "../../lib/subscription-radar";
import { buildManualBillRows, type LedgerExpense } from "../../lib/recurring-bills";
import { getLatestRateTable } from "../dal/exchange-rates";
import { listRecurringBills } from "../dal/recurring-bills";
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
  /** Set only on a row that comes from a bill the user typed in (AGENTS.md §3cccc). */
  manualBillId?: string;
  /** The day of the month a typed-in bill is due. */
  dueDay?: number;
};

/** A bill the user typed in, for the screen that manages them. */
export type ManualBillSummary = {
  id: string;
  name: string;
  currency: SubscriptionAnalysis["currency"];
  cadence: "monthly" | "quarterly" | "annual";
  /** Positive, minor units of `currency`. */
  nativeAmount: number;
  formattedAmount: string;
  /** The date the schedule is anchored on, `YYYY-MM-DD`. */
  anchorDate: string;
  categoryId: string | null;
  /** The next date it is due, `YYYY-MM-DD`; `null` when the radar has taken it over. */
  nextDueDate: string | null;
  /** What the radar detected it as from statements, so the bill is not counted twice; `null` while it still counts. */
  detectedAs: string | null;
  status: SubscriptionReviewStatus;
};

export type SubscriptionRadarData = {
  subscriptions: SubscriptionRow[];
  /** Every subscription or bill the user typed in, counted or not. */
  manualBills: ManualBillSummary[];
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
  const formatMoney = await getReportingFormatter(userId);
  const since = new Date(asOf.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const [occurrenceRows, statuses, rateTable, bills] = await Promise.all([
    getTransactionOccurrencesSince(userId, since),
    getSubscriptionStatuses(userId),
    getLatestRateTable(asOf),
    listRecurringBills(userId),
  ]);

  const occurrences: SubscriptionOccurrence[] = occurrenceRows.map((row) => ({
    merchantKey: row.merchantKey,
    displayName: row.displayName,
    currency: row.currency,
    nativeAmount: nativeAmount(Number(row.nativeAmount)),
    occurredAt: row.occurredAt,
    categoryId: row.categoryId,
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

  // Bills the user typed in join the SAME list, so Safe to Spend, the cost
  // totals and the runway's spending floor need no separate path for them.
  // A bill whose charges the radar has since detected is left out of the list
  // (never counted twice) and reported on its own below.
  const ledger: LedgerExpense[] = occurrenceRows
    .filter((row) => row.nativeAmount < 0n)
    .map((row) => ({ displayName: row.displayName, currency: row.currency, nativeAmount: Number(row.nativeAmount), occurredAt: row.occurredAt }));
  const manual = buildManualBillRows(
    bills,
    ledger,
    radarResult.subscriptions.map((s) => ({ displayName: s.displayName, isRecurring: s.isRecurring })),
    asOf,
  );
  for (const row of manual.rows) {
    subscriptions.push({
      ...row,
      status: statuses.get(row.merchantKey) ?? "ACTIVE",
      formattedCurrentAmount: formatNativeAmount(row.currentNativeAmount, row.currency),
      formattedPriceHike: null,
    });
  }
  const dayText = (date: Date) => date.toISOString().slice(0, 10);
  const manualBills: ManualBillSummary[] = bills.map((bill) => {
    const counted = manual.rows.find((row) => row.manualBillId === bill.id);
    const supersededBy = manual.superseded.find((entry) => entry.bill.id === bill.id)?.detectedAs ?? null;
    // A counted bill always has a row; a superseded one has no schedule of its own any more.
    const next = counted ? counted.nextExpectedDate : null;
    return {
      id: bill.id,
      name: bill.name,
      currency: bill.currency,
      cadence: bill.cadence,
      nativeAmount: bill.nativeAmount,
      formattedAmount: formatNativeAmount(nativeAmount(bill.nativeAmount), bill.currency),
      anchorDate: dayText(bill.anchorDate),
      categoryId: bill.categoryId,
      nextDueDate: next ? dayText(next) : null,
      detectedAs: supersededBy,
      status: statuses.get(`manual:${bill.id}`) ?? "ACTIVE",
    };
  });

  const activeForCashDrag = subscriptions.filter((s) => s.status !== "CANCELLED");
  const cashDrag = calculateCashDrag(activeForCashDrag, rateTable);

  return {
    manualBills,
    subscriptions: subscriptions.sort((a, b) => {
      // Active/reviewed subscriptions first, cancelled ones pushed to the
      // bottom — a cancelled subscription is still worth showing (so a
      // toggle can be undone) but shouldn't compete for attention.
      if (a.status === "CANCELLED" && b.status !== "CANCELLED") return 1;
      if (a.status !== "CANCELLED" && b.status === "CANCELLED") return -1;
      return 0;
    }),
    possibleFreeTrials: radarResult.possibleFreeTrials.map(buildFreeTrialRow),
    // The totals are in the reporting currency (AGENTS.md §3nnn); each
    // subscription's own price above stays in the currency it is charged in.
    cashDrag: { monthly: formatMoney(cashDrag.monthlyAgorot), annual: formatMoney(cashDrag.annualAgorot) },
    cashDragMonthlyAgorot: cashDrag.monthlyAgorot,
  };
});
