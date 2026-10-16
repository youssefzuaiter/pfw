import { nativeAmount, type CurrencyCode } from "./currency";
import { convertNativeAmountToAgorot } from "./exchange-rate";
import { addAgorot, agorot, subtractAgorot, type Agorot } from "./money";
import type { SubscriptionAnalysis } from "./subscription-radar";
import { containsWholeWord } from "./text-matching";

/**
 * "Safe to Spend": what is genuinely left to spend this month after the
 * money that is already spoken for. Pure functions over already-fetched
 * data, same `src/lib/` convention as every other engine (AGENTS.md §3b);
 * `src/server/analytics/build-safe-to-spend-data.ts` fetches the inputs.
 *
 * THE FORMULA (every figure ILS agorot, "this month" = the UTC calendar
 * month of `asOf`, as everywhere else in the app):
 *
 *   SafeToSpend = Cash − CardOwed − EnvelopeReserve − BillsNotCovered
 *                 − DebtDue − GoalDue
 *
 *   Cash            Σ checking (+ savings, unless the user keeps savings as a
 *                   reserve) accounts, each = its opening balance + the net
 *                   flow of live transactions dated after the day that balance
 *                   was true for (see `settleAccounts`). Transfers between the
 *                   user's own accounts ARE part of that flow, because they
 *                   really move an account's balance; both legs cancel.
 *   CardOwed        Σ credit-card accounts of max(0, opening owed − net flow).
 *                   Money already spent that has not left cash yet.
 *   EnvelopeReserve Σ envelopes of max(0, rolling balance). Money promised to
 *                   a category and not yet spent.
 *   BillsNotCovered Σ categories of max(0, pending bills − max(0, envelope)).
 *                   A recurring bill whose category has an envelope is paid
 *                   FROM that envelope, so only the part the envelope cannot
 *                   cover is deducted again.
 *   DebtDue         Σ debts of max(0, minimum payment − paid this month), the
 *                   minimum capped at what is still owed. A debt whose payment
 *                   is already a recurring bill the detection sees is left to
 *                   that bill (see `computeDebtsDue`).
 *   GoalDue         Σ goals of max(0, this month's required saving − what has
 *                   already been contributed this month).
 *
 * Edge cases, each pinned by a test:
 *
 *   - A bill already charged this month is not pending (it already left cash
 *     or is on the card). A bill whose charge has not landed yet is pending,
 *     and stays pending past its usual day: late is not paid.
 *   - An OVERSPENT envelope (negative balance) contributes 0, never a
 *     negative number. Subtracting a negative would ADD money back, which is
 *     the opposite of what overspending means. The overspend itself already
 *     reduced Cash when the money left; the clamp is what stops the envelope
 *     from giving it back.
 *   - Transfers between internal accounts are not income and not spending:
 *     the envelope and bill inputs are built from `REAL_MONEY` rows only, so
 *     a transfer never reaches them.
 *   - The result is NOT clamped: more promised than available is a negative
 *     number, and the caller shows it as such.
 *
 * Income not yet received is NOT in the headline figure: counting a paycheck
 * that has not arrived would make it optimistic. It is reported beside it
 * instead (`expectedIncomeAgorot`, and what the figure would be if it landed),
 * found the same way pending bills are, from recurring deposits.
 */

// === Accounts ================================================================

export type AccountInput = {
  accountType: string;
  /** The balance the user entered, converted to ILS. For a card: money owed, positive. */
  openingAgorot: Agorot;
  /** Net signed ILS amount of live transactions on the account dated after the day that balance was true for (or after the account was created, when no such day was given). */
  flowSinceOpeningAgorot: Agorot;
};

export type SettledAccounts = {
  /** Spendable cash: checking, plus savings when they are counted. */
  cashAgorot: Agorot;
  cardOwedAgorot: Agorot;
  /** What the savings accounts hold, counted or not. */
  savingsAgorot: Agorot;
  /** Whether `cashAgorot` includes `savingsAgorot`. */
  savingsCounted: boolean;
};

/**
 * Rolls each account's opening balance forward by the transactions made
 * since. `BankAccount.nativeBalance` is only ever the figure the user entered
 * (at creation, or when they last re-stated it); nothing updates it as
 * transactions arrive. Without this roll
 * forward, spending would never reduce Cash, and spending inside an
 * envelope would RAISE Safe to Spend (the envelope shrinks, the cash does
 * not).
 *
 * A deposit account's cash can be negative (an overdraft is real). A
 * card's debt cannot: an overpaid card is a credit with the bank, not
 * spendable cash, so it counts as owing 0.
 */
export function settleAccounts(
  accounts: readonly AccountInput[],
  options: { countSavings?: boolean } = {},
): SettledAccounts {
  const countSavings = options.countSavings ?? true;
  const cash: Agorot[] = [];
  const savings: Agorot[] = [];
  const owed: Agorot[] = [];
  for (const account of accounts) {
    if (account.accountType === "CREDIT_CARD") {
      // Stored positive = owed; a charge is a negative amount and raises it.
      const balance = subtractAgorot(account.openingAgorot, account.flowSinceOpeningAgorot);
      owed.push(balance > 0 ? balance : agorot(0));
    } else if (account.accountType === "SAVINGS") {
      savings.push(addAgorot(account.openingAgorot, account.flowSinceOpeningAgorot));
    } else {
      cash.push(addAgorot(account.openingAgorot, account.flowSinceOpeningAgorot));
    }
  }
  const savingsTotal = addAgorot(...savings);
  return {
    cashAgorot: countSavings ? addAgorot(...cash, savingsTotal) : addAgorot(...cash),
    cardOwedAgorot: addAgorot(...owed),
    savingsAgorot: savingsTotal,
    savingsCounted: countSavings,
  };
}

// === Recurring bills =========================================================

export type BillSource = Pick<
  SubscriptionAnalysis,
  "merchantKey" | "displayName" | "currency" | "currentNativeAmount" | "cadence" | "isRecurring" | "lastSeenAt" | "categoryId" | "averageIntervalDays"
> & { status: "ACTIVE" | "REVIEWED" | "CANCELLED" };

export type PendingBill = {
  merchantKey: string;
  displayName: string;
  categoryId: string | null;
  /** How many charges are still expected this month (more than 1 only for a weekly bill). */
  occurrences: number;
  amountEachAgorot: Agorot;
  totalAgorot: Agorot;
  /** The first charge still expected. */
  dueDate: Date;
  /** The usual day has passed and no charge has landed. Still counted: late is not paid. */
  overdue: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** Whole calendar months between charges, per cadence. Weekly is stepped by days instead. */
const MONTHS_BETWEEN_CHARGES = { monthly: 1, quarterly: 3, annual: 12 } as const;

function utcMonthIndex(date: Date): number {
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

function daysInUtcMonth(year: number, monthZeroBased: number): number {
  return new Date(Date.UTC(year, monthZeroBased + 1, 0)).getUTCDate();
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Recurring bills still to be charged this month.
 *
 * Monthly, quarterly and annual bills are placed by CALENDAR month, not by
 * adding an average interval to the last charge. A 31-day average from a
 * Jan 30 charge lands on Mar 2 and would skip February's bill entirely. A
 * bill is pending when this month is exactly one cadence step after its last
 * charge (so it has not been charged this month, and did not skip a cycle),
 * due on the same day of the month, or the month's last day if shorter. A
 * bill last seen MORE than one step ago has stopped and is not counted.
 *
 * A weekly bill can charge several times a month, so it is stepped forward
 * from its last charge by its average interval. Only the next expected
 * charge may be in the past (overdue); later ones count if they are still
 * ahead. A weekly bill gone quiet for over two intervals is treated as
 * stopped.
 *
 * Cancelled subscriptions and anything the radar did not confirm as
 * recurring are skipped. A foreign-currency bill converts at the latest
 * rate, like cash drag: this answers "what will it cost me now".
 */
export function findPendingBills(
  bills: readonly BillSource[],
  asOf: Date,
  rateTable: Readonly<Record<CurrencyCode, number>>,
): PendingBill[] {
  const monthIndex = utcMonthIndex(asOf);
  const year = asOf.getUTCFullYear();
  const month = asOf.getUTCMonth();
  const monthStart = new Date(Date.UTC(year, month, 1));
  const monthEnd = new Date(Date.UTC(year, month + 1, 1));
  const today = startOfUtcDay(asOf);
  const pending: PendingBill[] = [];

  for (const bill of bills) {
    if (!bill.isRecurring || bill.cadence === null || bill.status === "CANCELLED") continue;

    const amountEach = convertNativeAmountToAgorot(
      nativeAmount(Math.abs(Number(bill.currentNativeAmount))),
      bill.currency,
      rateTable[bill.currency],
    );
    if (amountEach <= 0) continue;

    const dueDates: Date[] = [];
    if (bill.cadence === "weekly") {
      const interval = bill.averageIntervalDays && bill.averageIntervalDays > 0 ? bill.averageIntervalDays : 7;
      if (today.getTime() - bill.lastSeenAt.getTime() > (2 * interval + 3) * DAY_MS) continue;
      for (let step = 1; ; step++) {
        const due = new Date(bill.lastSeenAt.getTime() + step * interval * DAY_MS);
        if (due >= monthEnd) break;
        if (due < monthStart) continue;
        if (step === 1 || due >= today) dueDates.push(due);
      }
    } else {
      const gap = MONTHS_BETWEEN_CHARGES[bill.cadence];
      if (monthIndex - utcMonthIndex(bill.lastSeenAt) !== gap) continue;
      const day = Math.min(bill.lastSeenAt.getUTCDate(), daysInUtcMonth(year, month));
      dueDates.push(new Date(Date.UTC(year, month, day)));
    }

    if (dueDates.length === 0) continue;
    pending.push({
      merchantKey: bill.merchantKey,
      displayName: bill.displayName,
      categoryId: bill.categoryId,
      occurrences: dueDates.length,
      amountEachAgorot: amountEach,
      totalAgorot: agorot(Number(amountEach) * dueDates.length),
      dueDate: dueDates[0],
      overdue: dueDates[0] < today,
    });
  }

  return pending.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
}

// === Debts ===================================================================

export type DebtInput = {
  debtId: string;
  name: string;
  /** What is still owed. */
  balanceAgorot: Agorot;
  minimumPaymentAgorot: Agorot;
  /** Payments recorded against this debt dated in this calendar month. */
  paidThisMonthAgorot: Agorot;
};

export type DebtDue = {
  debtId: string;
  name: string;
  /** The month's minimum, capped at what is still owed. */
  minimumAgorot: Agorot;
  paidThisMonthAgorot: Agorot;
  /** What is still owed to this debt this month. Zero when it is already paid, or handled by a recurring bill. */
  dueAgorot: Agorot;
  /** The recurring bill this debt's payment already shows up as, so it is not counted twice. */
  handledByBill: string | null;
};

/** A one- or two-letter name would match almost any bill, so it never links a debt to one. */
const MIN_NAME_LENGTH_TO_MATCH = 3;

/**
 * Each debt's minimum payment still to be made this month.
 *
 * A `Debt` has no due day, so the whole minimum is treated as due this
 * month, and counted from the 1st: an obligation, not a forecast of when it
 * leaves the account. The payments recorded against the debt this month are
 * credited, and the minimum never exceeds what is still owed. Interest is
 * ignored: the minimum is what the lender asks for.
 *
 * Double counting is the danger, because a loan repayment often also appears
 * as a recurring transaction that bill detection already counts (or already
 * saw paid this month). So a debt whose name appears, as a whole word, in the
 * name of a recurring bill (or the bill's name in the debt's) is left to that
 * bill and owes 0 here, naming the bill. That guess can only err on the side
 * of counting a debt twice, never of dropping an obligation unseen: a debt
 * whose bill uses a different name is simply counted, and the breakdown shows
 * it so the mismatch is visible. `billNames` are all confirmed recurring,
 * non-cancelled bills, not only the pending ones.
 */
export function computeDebtsDue(debts: readonly DebtInput[], billNames: readonly string[]): DebtDue[] {
  const dues: DebtDue[] = [];
  for (const debt of debts) {
    if (debt.balanceAgorot <= 0 || debt.minimumPaymentAgorot <= 0) continue;

    const name = debt.name.trim();
    const bill = billNames.find(
      (billName) =>
        billName.trim().length >= MIN_NAME_LENGTH_TO_MATCH &&
        name.length >= MIN_NAME_LENGTH_TO_MATCH &&
        (containsWholeWord(billName, name) || containsWholeWord(name, billName)),
    );
    const minimum = Math.min(debt.minimumPaymentAgorot, debt.balanceAgorot);
    const due = bill !== undefined ? 0 : Math.max(0, minimum - debt.paidThisMonthAgorot);
    dues.push({
      debtId: debt.debtId,
      name: debt.name,
      minimumAgorot: agorot(minimum),
      paidThisMonthAgorot: debt.paidThisMonthAgorot,
      dueAgorot: agorot(due),
      handledByBill: bill ?? null,
    });
  }
  return dues;
}

// === Goals ===================================================================

export type GoalInput = {
  goalId: string;
  name: string;
  targetAgorot: Agorot;
  /** Everything contributed so far, withdrawals netted. */
  currentAgorot: Agorot;
  /** Contributions dated in this calendar month, withdrawals netted. */
  contributedThisMonthAgorot: Agorot;
  targetDate: Date | null;
};

export type GoalDue = {
  goalId: string;
  name: string;
  /** Calendar months left including this one, at least 1. */
  monthsLeft: number;
  /** What this month needs to stay on a straight line to the target. */
  requiredThisMonthAgorot: Agorot;
  contributedThisMonthAgorot: Agorot;
  /** What is still owed to the goal this month. Never negative, never more than the goal still needs. */
  dueAgorot: Agorot;
};

/**
 * Each dated goal's share of THIS month. The remaining amount is measured at
 * the START of the month (current minus this month's contributions) so that
 * contributing does not shrink the requirement it is being measured against.
 * It is spread evenly over the calendar months left, this one included, and
 * the contributions already made this month are credited against it.
 *
 * Goals with no date, goals already reached, and goals past their date have
 * no monthly pace to keep and owe nothing here.
 */
export function computeGoalsDue(goals: readonly GoalInput[], asOf: Date): GoalDue[] {
  const dues: GoalDue[] = [];
  for (const goal of goals) {
    if (goal.targetDate === null) continue;
    if (goal.currentAgorot >= goal.targetAgorot) continue;
    if (goal.targetDate.getTime() <= asOf.getTime()) continue;

    const monthsLeft = Math.max(1, utcMonthIndex(goal.targetDate) - utcMonthIndex(asOf) + 1);
    const remainingAtMonthStart = goal.targetAgorot - (goal.currentAgorot - goal.contributedThisMonthAgorot);
    const required = Math.ceil(remainingAtMonthStart / monthsLeft);
    const stillNeeded = goal.targetAgorot - goal.currentAgorot;
    const due = Math.min(Math.max(0, required - goal.contributedThisMonthAgorot), stillNeeded);

    dues.push({
      goalId: goal.goalId,
      name: goal.name,
      monthsLeft,
      requiredThisMonthAgorot: agorot(required),
      contributedThisMonthAgorot: goal.contributedThisMonthAgorot,
      dueAgorot: agorot(due),
    });
  }
  return dues;
}

// === Safe to Spend ===========================================================

export type EnvelopeInput = {
  categoryId: string;
  categoryName: string;
  /** Rolling balance: every allocation minus every expense, carried forward. Negative = overspent. */
  balanceAgorot: Agorot;
};

export type SafeToSpendInput = {
  cashAgorot: Agorot;
  cardOwedAgorot: Agorot;
  /** What the savings accounts hold, and whether `cashAgorot` counts it. Reported, not used in the sum. */
  savingsAgorot?: Agorot;
  savingsCounted?: boolean;
  pendingBills: readonly PendingBill[];
  envelopes: readonly EnvelopeInput[];
  debtsDue?: readonly DebtDue[];
  goalsDue: readonly GoalDue[];
  /** Recurring deposits still expected this month. Reported beside the figure, never added into it. */
  expectedIncome?: readonly PendingBill[];
};

export type BillLine = PendingBill & {
  /** The part of this bill the category's envelope already holds, so it is not deducted twice. */
  coveredByEnvelopeAgorot: Agorot;
  /** The part this bill adds to the deduction. */
  deductedAgorot: Agorot;
};

export type OverspentEnvelope = { categoryId: string; categoryName: string; overspentAgorot: Agorot };

export type SafeToSpendResult = {
  safeToSpendAgorot: Agorot;
  /** Promised more than is available. */
  isOverCommitted: boolean;
  cashAgorot: Agorot;
  cardOwedAgorot: Agorot;
  envelopeReserveAgorot: Agorot;
  billsNotCoveredAgorot: Agorot;
  debtDueAgorot: Agorot;
  goalDueAgorot: Agorot;
  savingsAgorot: Agorot;
  savingsCounted: boolean;
  /** Recurring deposits still expected this month, not in the figure. */
  expectedIncomeAgorot: Agorot;
  expectedIncome: PendingBill[];
  /** What the figure would be if all of that expected income arrived. */
  safeToSpendWithExpectedIncomeAgorot: Agorot;
  debts: DebtDue[];
  /** Every pending bill, with how much of it an envelope covers. */
  bills: BillLine[];
  /** Every envelope below zero, largest overspend first: the same set the Attention Feed calls overdrawn. Shown for context; the money is already out of Cash and adds nothing back. */
  overspentEnvelopes: OverspentEnvelope[];
  goals: GoalDue[];
};

export function computeSafeToSpend(input: SafeToSpendInput): SafeToSpendResult {
  const reserveByCategory = new Map<string, number>();
  let envelopeReserve = 0;
  const overspent: OverspentEnvelope[] = [];
  for (const envelope of input.envelopes) {
    if (envelope.balanceAgorot > 0) {
      reserveByCategory.set(envelope.categoryId, (reserveByCategory.get(envelope.categoryId) ?? 0) + envelope.balanceAgorot);
      envelopeReserve += envelope.balanceAgorot;
    } else if (envelope.balanceAgorot < 0) {
      overspent.push({
        categoryId: envelope.categoryId,
        categoryName: envelope.categoryName,
        overspentAgorot: agorot(-envelope.balanceAgorot),
      });
    }
  }

  // Each category's envelope pays its own bills first, soonest due first.
  // Whatever the envelope cannot hold is the only part deducted again.
  const remainingCover = new Map(reserveByCategory);
  let billsNotCovered = 0;
  const bills: BillLine[] = input.pendingBills.map((bill) => {
    const available = bill.categoryId === null ? 0 : (remainingCover.get(bill.categoryId) ?? 0);
    const covered = Math.min(available, bill.totalAgorot);
    if (bill.categoryId !== null && covered > 0) remainingCover.set(bill.categoryId, available - covered);
    const deducted = bill.totalAgorot - covered;
    billsNotCovered += deducted;
    return { ...bill, coveredByEnvelopeAgorot: agorot(covered), deductedAgorot: agorot(deducted) };
  });

  overspent.sort((x, y) => y.overspentAgorot - x.overspentAgorot);

  const goalDue = input.goalsDue.reduce((sum, goal) => sum + goal.dueAgorot, 0);
  const debtsDue = input.debtsDue ?? [];
  const debtDue = debtsDue.reduce((sum, debt) => sum + debt.dueAgorot, 0);
  const expectedIncome = input.expectedIncome ?? [];
  const expectedIncomeTotal = expectedIncome.reduce((sum, income) => sum + income.totalAgorot, 0);

  const safeToSpend = agorot(
    input.cashAgorot - input.cardOwedAgorot - envelopeReserve - billsNotCovered - debtDue - goalDue,
  );

  return {
    safeToSpendAgorot: safeToSpend,
    isOverCommitted: safeToSpend < 0,
    cashAgorot: input.cashAgorot,
    cardOwedAgorot: input.cardOwedAgorot,
    envelopeReserveAgorot: agorot(envelopeReserve),
    billsNotCoveredAgorot: agorot(billsNotCovered),
    debtDueAgorot: agorot(debtDue),
    goalDueAgorot: agorot(goalDue),
    savingsAgorot: input.savingsAgorot ?? agorot(0),
    savingsCounted: input.savingsCounted ?? true,
    expectedIncomeAgorot: agorot(expectedIncomeTotal),
    expectedIncome: [...expectedIncome],
    safeToSpendWithExpectedIncomeAgorot: agorot(safeToSpend + expectedIncomeTotal),
    debts: [...debtsDue],
    bills,
    overspentEnvelopes: overspent,
    goals: [...input.goalsDue],
  };
}
