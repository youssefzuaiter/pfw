import "server-only";
import { cache } from "react";
import { agorot, type Agorot } from "../../lib/money";
import { getReportingContext, getReportingFormatter } from "../reporting/reporting-context";
import { formatReportingMinorUnits, sumFlowsInReporting, type ReportingFlow } from "../../lib/reporting-currency";
import { findPendingBills } from "../../lib/safe-to-spend";
import { formatMonthKey, monthKeyFor, monthKeyToExclusiveEndDate, monthKeyToStartDate } from "../../lib/date-month";
import { formatNativeAmount, nativeAmount } from "../../lib/currency";
import {
  calculateCashDrag,
  runSubscriptionRadar,
  type PossibleFreeTrial,
  type SubscriptionAnalysis,
  type SubscriptionOccurrence,
} from "../../lib/subscription-radar";
import { convertNativeAmountToAgorot } from "../../lib/exchange-rate";
import {
  buildManualBillRows,
  chargesInPeriod,
  projectManualBillEvents,
  type LedgerExpense,
  type RecurringBillInput,
  type RecurringBillKind,
} from "../../lib/recurring-bills";
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
  /** Which page a typed-in row belongs to; set together with `manualBillId`. */
  manualBillKind?: RecurringBillKind;
  /** The day of the month a typed-in bill is due. */
  dueDay?: number;
};

/** A bill the user typed in, for the screen that manages them. */
export type ManualBillSummary = {
  id: string;
  kind: RecurringBillKind;
  name: string;
  currency: SubscriptionAnalysis["currency"];
  cadence: "monthly" | "quarterly" | "annual";
  /** Positive, minor units of `currency`: what was typed. */
  nativeAmount: number;
  /** The charge is different every time (billed by use). */
  amountVaries: boolean;
  /** What it is expected to cost: for a varying bill, the average of its last few real payments; otherwise the typed amount. */
  expectedNativeAmount: number;
  /** For a varying bill, how many real payments the expected amount was averaged from; 0 means it is still the typed amount. */
  estimateBasedOnPayments: number;
  /** The expected amount as text. */
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

/** What one page has cost this calendar month: what was actually charged, and what is still to come. */
export type MonthTotals = {
  /** For example "October 2026". */
  monthLabel: string;
  /** Charges dated this month for what the page lists, from the ledger. Formatted in the reporting currency. */
  spent: string;
  spentCount: number;
  /** Charges still expected before the month ends. Formatted in the reporting currency. */
  stillDue: string;
  stillDueCount: number;
};

export type SubscriptionRadarData = {
  subscriptions: SubscriptionRow[];
  /** Every subscription or bill the user typed in, counted or not. */
  manualBills: ManualBillSummary[];
  possibleFreeTrials: (ReturnType<typeof buildFreeTrialRow>)[];
  cashDrag: { monthly: string; annual: string };
  /** What the Subscriptions page totals: statement-detected subscriptions plus the subscriptions typed in. */
  /** This calendar month, per page: the Subscriptions page and the Bills page each total only their own items. */
  monthTotals: { subscriptions: MonthTotals; bills: MonthTotals };
  subscriptionsCashDrag: { monthly: string; annual: string };
  /** What the Bills page totals: only the bills typed in. */
  billsCashDrag: { monthly: string; annual: string };
  /** The same monthly cash-drag total as `cashDrag.monthly`, as a raw `Agorot` rather than a formatted display string — added for the Real-Time Liquidity Runway & Burn-Rate Engine (AGENTS.md §3v), which needs the actual number to compute a burn-rate floor, not text to render. Purely additive; the existing `cashDrag` field and every prior consumer of it are unchanged. */
  cashDragMonthlyAgorot: Agorot;
  /**
   * What the cash-flow forecast needs from the bills typed in (AGENTS.md §3llll):
   * the bills that still count (not cancelled, not taken over by a detected
   * subscription), and their charges still to come in the forecast window, in
   * shekels at the latest rate. A varying bill is at its expected amount.
   */
  forecast: {
    bills: RecurringBillInput[];
    events: { merchantKey: string; name: string; date: Date; amountAgorot: Agorot }[];
  };
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
  const reporting = await getReportingContext(userId);
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
    .map((row) => ({
      displayName: row.displayName,
      amountAgorot: Number(row.amount),
      currency: row.currency,
      nativeAmount: Number(row.nativeAmount),
      occurredAt: row.occurredAt,
    }));
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
    const expected = counted?.amountEstimate?.nativeAmount ?? bill.nativeAmount;
    return {
      id: bill.id,
      kind: bill.kind,
      name: bill.name,
      currency: bill.currency,
      cadence: bill.cadence,
      nativeAmount: bill.nativeAmount,
      amountVaries: bill.amountVaries,
      expectedNativeAmount: expected,
      estimateBasedOnPayments: counted?.amountEstimate?.basedOnPayments ?? 0,
      formattedAmount: formatNativeAmount(nativeAmount(expected), bill.currency),
      anchorDate: dayText(bill.anchorDate),
      categoryId: bill.categoryId,
      nextDueDate: next ? dayText(next) : null,
      detectedAs: supersededBy,
      status: statuses.get(`manual:${bill.id}`) ?? "ACTIVE",
    };
  });

  // The bills that still count for the forecast: shown in the list (so not
  // taken over by a detected subscription) and not cancelled.
  const countedIds = new Set(manual.rows.map((row) => row.manualBillId));
  const forecastBills = bills.filter((bill) => countedIds.has(bill.id) && (statuses.get(`manual:${bill.id}`) ?? "ACTIVE") !== "CANCELLED");
  const forecastEvents = projectManualBillEvents(forecastBills, ledger, asOf).map((event) => ({
    merchantKey: `manual:${event.billId}`,
    name: event.name,
    date: event.date,
    amountAgorot: convertNativeAmountToAgorot(nativeAmount(event.nativeAmount), event.currency, rateTable[event.currency]),
  }));

  const activeForCashDrag = subscriptions.filter((s) => s.status !== "CANCELLED");
  const cashDrag = calculateCashDrag(activeForCashDrag, rateTable);
  // Each page totals only what it lists. The combined figure above still feeds
  // Safe to Spend and the runway, which care about everything that leaves.
  const subscriptionsDrag = calculateCashDrag(
    activeForCashDrag.filter((row) => row.manualBillKind !== "bill"),
    rateTable,
  );
  const billsDrag = calculateCashDrag(
    activeForCashDrag.filter((row) => row.manualBillKind === "bill"),
    rateTable,
  );

  // What each page spent this calendar month. The charges come from the ledger by
  // the date the money left, so a charge settling last month's due date is not
  // counted here. Spending is counted even for a subscription cancelled since.
  const monthKey = monthKeyFor(asOf);
  const monthStart = monthKeyToStartDate(monthKey);
  const monthEnd = monthKeyToExclusiveEndDate(monthKey);
  const toFlow = (row: LedgerExpense): ReportingFlow => ({
    amount: Math.abs(row.amountAgorot ?? 0),
    occurredAt: row.occurredAt,
    currency: row.currency,
    nativeAmount: Math.abs(row.nativeAmount),
  });
  const ledgerThisMonth = ledger.filter((row) => row.occurredAt >= monthStart && row.occurredAt < monthEnd);
  const detectedCharges: LedgerExpense[] = [];
  for (const row of subscriptions) {
    if (row.manualBillId || !row.memberMerchantKeys) continue;
    const keys = new Set(row.memberMerchantKeys);
    for (const charge of occurrenceRows) {
      if (charge.nativeAmount >= 0n || charge.currency !== row.currency || !keys.has(charge.merchantKey)) continue;
      if (charge.occurredAt < monthStart || charge.occurredAt >= monthEnd) continue;
      detectedCharges.push({ displayName: charge.displayName, amountAgorot: Number(charge.amount), currency: charge.currency, nativeAmount: Number(charge.nativeAmount), occurredAt: charge.occurredAt });
    }
  }
  const manualCharges = (kind: RecurringBillKind) =>
    bills.filter((bill) => bill.kind === kind).flatMap((bill) => chargesInPeriod(bill, ledgerThisMonth, monthStart, monthEnd));
  const totalsFor = (charges: LedgerExpense[], rows: SubscriptionRow[]): MonthTotals => {
    const pending = findPendingBills(rows, asOf, rateTable);
    return {
      monthLabel: formatMonthKey(monthKey),
      spent: formatReportingMinorUnits(sumFlowsInReporting(charges.map(toFlow), reporting), reporting),
      spentCount: charges.length,
      stillDue: formatMoney(agorot(pending.reduce((sum, item) => sum + Number(item.totalAgorot), 0))),
      stillDueCount: pending.reduce((sum, item) => sum + item.occurrences, 0),
    };
  };
  const monthTotals = {
    subscriptions: totalsFor(
      [...detectedCharges, ...manualCharges("subscription")],
      subscriptions.filter((row) => row.manualBillKind !== "bill"),
    ),
    bills: totalsFor(manualCharges("bill"), subscriptions.filter((row) => row.manualBillKind === "bill")),
  };

  return {
    forecast: { bills: forecastBills, events: forecastEvents },
    monthTotals,
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
    subscriptionsCashDrag: { monthly: formatMoney(subscriptionsDrag.monthlyAgorot), annual: formatMoney(subscriptionsDrag.annualAgorot) },
    billsCashDrag: { monthly: formatMoney(billsDrag.monthlyAgorot), annual: formatMoney(billsDrag.annualAgorot) },
    cashDragMonthlyAgorot: cashDrag.monthlyAgorot,
  };
});
