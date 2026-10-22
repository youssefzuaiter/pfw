import "server-only";
import { cache } from "react";
import { nativeAmount } from "../../lib/currency";
import { monthKeyFor, monthKeyToExclusiveEndDate, monthKeyToStartDate } from "../../lib/date-month";
import { agorot } from "../../lib/money";
import {
  computeDebtsDue,
  computeGoalsDue,
  computeSafeToSpend,
  findPendingBills,
  settleAccounts,
  type BillSource,
  type SafeToSpendResult,
} from "../../lib/safe-to-spend";
import { runSubscriptionRadar, type SubscriptionOccurrence } from "../../lib/subscription-radar";
import { currentBalanceAgorot } from "../../lib/account-balance";
import { listAccountBalanceParts } from "../dal/account-balances";
import { getEnvelopeBalances } from "../dal/envelopes";
import { getLatestRateTable } from "../dal/exchange-rates";
import { listDebts } from "../dal/debts";
import { listGoals } from "../dal/goals";
import { getTransactionOccurrencesSince } from "../dal/transactions";
import { getSafeToSpendCountSavings } from "../dal/user-settings";
import { buildSubscriptionRadarData } from "../subscriptions/build-subscription-radar-data";

/** How far back recurring deposits are looked for; matches the bill radar's own lookback. */
const INCOME_LOOKBACK_DAYS = 400;

export type SafeToSpendData = SafeToSpendResult & {
  /** `YYYY-MM`, the UTC calendar month the figure is for. */
  month: string;
  asOf: Date;
};

/**
 * Assembles Safe to Spend (formula and edge cases: `src/lib/safe-to-spend.ts`)
 * from the data that already exists: account balances rolled forward by
 * their transactions, envelope balances, the subscription radar's confirmed
 * recurring bills, and goal contributions. This is the selector the
 * dashboard card and `GET /api/analytics/safe-to-spend` both read, so the
 * two cannot disagree.
 *
 * `cache()`-wrapped like every other `build-*-data.ts` aggregator (§3c). It
 * takes `asOf` as an optional second argument and forwards it unchanged, so
 * a caller that passes none shares the radar's per-request cache with the
 * liquidity runway card rather than running the radar twice.
 *
 * Debt minimums come from `Debt` and the payments recorded against it this
 * month; savings count unless the user turned that off in settings; and
 * recurring deposits still to arrive are reported beside the figure (never in
 * it).
 *
 * Envelope balances and bill detection read `REAL_MONEY` rows only, so a
 * transfer between the user's own accounts is neither spending nor income
 * there; account balances read every live row, because a transfer does move
 * a balance (§3ccc).
 */
export const buildSafeToSpendData = cache(async function buildSafeToSpendData(
  userId: string,
  asOf?: Date,
): Promise<SafeToSpendData> {
  const now = asOf ?? new Date();
  const month = monthKeyFor(now);
  const monthStart = monthKeyToStartDate(month);
  const monthEnd = monthKeyToExclusiveEndDate(month);

  const [accountRows, rateTable, envelopes, radar, goals, debts, countSavings, occurrenceRows] = await Promise.all([
    listAccountBalanceParts(userId),
    getLatestRateTable(now),
    getEnvelopeBalances(userId, month),
    buildSubscriptionRadarData(userId, asOf),
    listGoals(userId),
    listDebts(userId),
    getSafeToSpendCountSavings(userId),
    getTransactionOccurrencesSince(userId, new Date(now.getTime() - INCOME_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)),
  ]);

  const { cashAgorot, cardOwedAgorot, savingsAgorot, savingsCounted } = settleAccounts(
    accountRows.map(({ parts }) => ({
      accountType: parts.accountType,
      balanceAgorot: currentBalanceAgorot(parts, rateTable[parts.currency]),
    })),
    { countSavings },
  );

  const pendingBills = findPendingBills(radar.subscriptions, now, rateTable);

  // A debt's repayment that is already a recurring bill must not be counted twice.
  const billNames = radar.subscriptions.filter((s) => s.isRecurring && s.status !== "CANCELLED").map((s) => s.displayName);
  const debtsDue = computeDebtsDue(
    debts.map((debt) => ({
      debtId: debt.id,
      name: debt.name,
      balanceAgorot: agorot(Number(debt.currentBalance)),
      minimumPaymentAgorot: agorot(Number(debt.minimumPayment)),
      paidThisMonthAgorot: agorot(
        debt.payments.filter((p) => p.paidAt >= monthStart && p.paidAt < monthEnd).reduce((sum, p) => sum + Number(p.amount), 0),
      ),
    })),
    billNames,
  );

  // Recurring deposits, found the way recurring bills are: the radar only
  // follows spending, so deposits are fed to it as if they were charges.
  const incomeOccurrences: SubscriptionOccurrence[] = occurrenceRows
    .filter((row) => row.nativeAmount > 0n)
    .map((row) => ({
      merchantKey: row.merchantKey,
      displayName: row.displayName,
      currency: row.currency,
      nativeAmount: nativeAmount(-Number(row.nativeAmount)),
      occurredAt: row.occurredAt,
      categoryId: row.categoryId,
    }));
  const incomeSources: BillSource[] = runSubscriptionRadar(incomeOccurrences, now).subscriptions.map((analysis) => ({
    ...analysis,
    status: "ACTIVE",
  }));
  const expectedIncome = findPendingBills(incomeSources, now, rateTable);

  const goalsDue = computeGoalsDue(
    goals.map((goal) => {
      const current = goal.contributions.reduce((sum, c) => sum + Number(c.amount), 0);
      const thisMonth = goal.contributions
        .filter((c) => c.contributedAt >= monthStart && c.contributedAt < monthEnd)
        .reduce((sum, c) => sum + Number(c.amount), 0);
      return {
        goalId: goal.id,
        name: goal.name,
        targetAgorot: agorot(Number(goal.targetAmount)),
        currentAgorot: agorot(current),
        contributedThisMonthAgorot: agorot(thisMonth),
        targetDate: goal.targetDate,
      };
    }),
    now,
  );

  const result = computeSafeToSpend({
    cashAgorot,
    cardOwedAgorot,
    savingsAgorot,
    savingsCounted,
    pendingBills,
    envelopes: envelopes.map((envelope) => ({
      categoryId: envelope.categoryId,
      categoryName: envelope.categoryName,
      balanceAgorot: envelope.balanceAgorot,
    })),
    debtsDue,
    goalsDue,
    expectedIncome,
  });

  return { ...result, month, asOf: now };
});

/** The JSON shape `GET /api/analytics/safe-to-spend` returns: agorot as plain numbers (all are safe integers), dates as ISO strings. */
export function serializeSafeToSpend(data: SafeToSpendData) {
  return {
    month: data.month,
    asOf: data.asOf.toISOString(),
    safeToSpendAgorot: data.safeToSpendAgorot,
    isOverCommitted: data.isOverCommitted,
    cashAgorot: data.cashAgorot,
    cardOwedAgorot: data.cardOwedAgorot,
    envelopeReserveAgorot: data.envelopeReserveAgorot,
    billsNotCoveredAgorot: data.billsNotCoveredAgorot,
    debtDueAgorot: data.debtDueAgorot,
    goalDueAgorot: data.goalDueAgorot,
    savingsAgorot: data.savingsAgorot,
    savingsCounted: data.savingsCounted,
    expectedIncomeAgorot: data.expectedIncomeAgorot,
    safeToSpendWithExpectedIncomeAgorot: data.safeToSpendWithExpectedIncomeAgorot,
    expectedIncome: data.expectedIncome.map((income) => ({
      merchantKey: income.merchantKey,
      displayName: income.displayName,
      occurrences: income.occurrences,
      amountEachAgorot: income.amountEachAgorot,
      totalAgorot: income.totalAgorot,
      dueDate: income.dueDate.toISOString(),
      overdue: income.overdue,
    })),
    debts: data.debts,
    bills: data.bills.map((bill) => ({
      merchantKey: bill.merchantKey,
      displayName: bill.displayName,
      categoryId: bill.categoryId,
      occurrences: bill.occurrences,
      amountEachAgorot: bill.amountEachAgorot,
      totalAgorot: bill.totalAgorot,
      dueDate: bill.dueDate.toISOString(),
      overdue: bill.overdue,
      coveredByEnvelopeAgorot: bill.coveredByEnvelopeAgorot,
      deductedAgorot: bill.deductedAgorot,
    })),
    overspentEnvelopes: data.overspentEnvelopes,
    goals: data.goals,
  };
}
