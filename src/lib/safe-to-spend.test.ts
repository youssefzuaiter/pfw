import { describe, expect, it } from "vitest";
import { nativeAmount } from "./currency";
import { agorot } from "./money";
import {
  computeDebtsDue,
  computeGoalsDue,
  computeSafeToSpend,
  findPendingBills,
  settleAccounts,
  type BillSource,
  type DebtInput,
  type EnvelopeInput,
  type GoalInput,
  type PendingBill,
} from "./safe-to-spend";

const RATES = { ILS: 1, USD: 3.7, EUR: 4, GBP: 4.7, TRY: 0.09 } as const;
/** Mid-month: the 16th of October 2026. */
const MID_OCT = new Date("2026-10-16T09:00:00Z");

const a = agorot;
function day(iso: string) {
  return new Date(`${iso}T00:00:00Z`);
}

function bill(overrides: Partial<BillSource> & { lastSeenAt: Date }): BillSource {
  return {
    merchantKey: "rent",
    displayName: "Rent",
    currency: "ILS",
    currentNativeAmount: nativeAmount(-400_000),
    cadence: "monthly",
    isRecurring: true,
    categoryId: null,
    averageIntervalDays: 30,
    status: "ACTIVE",
    ...overrides,
  };
}

function pending(overrides: Partial<PendingBill> = {}): PendingBill {
  return {
    merchantKey: "rent",
    displayName: "Rent",
    categoryId: null,
    occurrences: 1,
    amountEachAgorot: a(400_000),
    totalAgorot: a(400_000),
    dueDate: day("2026-10-25"),
    overdue: false,
    ...overrides,
  };
}

function envelope(categoryId: string, balance: number): EnvelopeInput {
  return { categoryId, categoryName: categoryId, balanceAgorot: a(balance) };
}

function safe(input: Partial<Parameters<typeof computeSafeToSpend>[0]>) {
  return computeSafeToSpend({
    cashAgorot: a(0),
    cardOwedAgorot: a(0),
    pendingBills: [],
    envelopes: [],
    goalsDue: [],
    ...input,
  });
}

describe("settleAccounts", () => {
  it("adds the flow since creation to a deposit account and sums checking and savings", () => {
    const settled = settleAccounts([
      { accountType: "CHECKING", balanceAgorot: a(750_000) },
      { accountType: "SAVINGS", balanceAgorot: a(600_000) },
    ]);
    expect(settled.cashAgorot).toBe(1_350_000);
    expect(settled.cardOwedAgorot).toBe(0);
  });

  it("raises what a card owes when it is charged and lowers it when it is paid", () => {
    // Typed 300,000 owed; a charge of 120,000 raises it, a payment of 100,000 lowers it.
    const card = (balance: number) => settleAccounts([{ accountType: "CREDIT_CARD", balanceAgorot: a(balance) }]);
    expect(card(300_000 + 120_000).cardOwedAgorot).toBe(420_000);
    expect(card(300_000 - 100_000).cardOwedAgorot).toBe(200_000);
  });

  it("counts an overpaid card as owing nothing, not as spendable cash", () => {
    const settled = settleAccounts([{ accountType: "CREDIT_CARD", balanceAgorot: a(-150_000) }]);
    expect(settled).toMatchObject({ cashAgorot: 0, cardOwedAgorot: 0 });
  });

  it("counts savings as spendable cash by default, and reports them", () => {
    const settled = settleAccounts([
      { accountType: "CHECKING", balanceAgorot: a(100_000) },
      { accountType: "SAVINGS", balanceAgorot: a(550_000) },
    ]);
    expect(settled).toMatchObject({ cashAgorot: 650_000, savingsAgorot: 550_000, savingsCounted: true });
  });

  it("leaves savings out of cash when they are kept as a reserve, but still reports them", () => {
    const settled = settleAccounts(
      [
        { accountType: "CHECKING", balanceAgorot: a(80_000) },
        { accountType: "SAVINGS", balanceAgorot: a(550_000) },
      ],
      { countSavings: false },
    );
    expect(settled).toMatchObject({ cashAgorot: 80_000, savingsAgorot: 550_000, savingsCounted: false });
  });

  it("a transfer from checking into savings changes cash only when savings are not counted", () => {
    const accounts = (counted: boolean) =>
      settleAccounts(
        [
          { accountType: "CHECKING", balanceAgorot: a(60_000) },
          { accountType: "SAVINGS", balanceAgorot: a(40_000) },
        ],
        { countSavings: counted },
      ).cashAgorot;
    expect(accounts(true)).toBe(100_000);
    expect(accounts(false)).toBe(60_000);
  });

  it("keeps an overdraft negative", () => {
    expect(settleAccounts([{ accountType: "CHECKING", balanceAgorot: a(-50_000) }]).cashAgorot).toBe(-50_000);
  });
});

describe("findPendingBills: paid vs still pending", () => {
  it("counts a monthly bill last charged last month and not yet charged this month", () => {
    const [found] = findPendingBills([bill({ lastSeenAt: day("2026-09-25") })], MID_OCT, RATES);
    expect(found.totalAgorot).toBe(400_000);
    expect(found.dueDate).toEqual(day("2026-10-25"));
    expect(found.overdue).toBe(false);
  });

  it("does not count a bill that has already been charged this month", () => {
    expect(findPendingBills([bill({ lastSeenAt: day("2026-10-03") })], MID_OCT, RATES)).toEqual([]);
  });

  it("keeps counting a bill whose usual day has passed without a charge, and flags it overdue", () => {
    const [found] = findPendingBills([bill({ lastSeenAt: day("2026-09-05") })], MID_OCT, RATES);
    expect(found.overdue).toBe(true);
    expect(found.totalAgorot).toBe(400_000);
  });

  it("does not count a bill that has stopped (skipped a whole cycle)", () => {
    expect(findPendingBills([bill({ lastSeenAt: day("2026-08-12") })], MID_OCT, RATES)).toEqual([]);
  });

  it("skips cancelled subscriptions and anything not confirmed recurring", () => {
    const recent = day("2026-09-25");
    expect(findPendingBills([bill({ lastSeenAt: recent, status: "CANCELLED" })], MID_OCT, RATES)).toEqual([]);
    expect(findPendingBills([bill({ lastSeenAt: recent, isRecurring: false })], MID_OCT, RATES)).toEqual([]);
    expect(findPendingBills([bill({ lastSeenAt: recent, cadence: null })], MID_OCT, RATES)).toEqual([]);
  });

  it("does not skip February for a bill last charged on January 30", () => {
    const [found] = findPendingBills([bill({ lastSeenAt: day("2027-01-30") })], new Date("2027-02-10T00:00:00Z"), RATES);
    expect(found.dueDate).toEqual(day("2027-02-28"));
  });

  it("expects a quarterly bill three months after its last charge and an annual one twelve", () => {
    const quarterly = bill({ cadence: "quarterly", lastSeenAt: day("2026-07-10") });
    expect(findPendingBills([quarterly], MID_OCT, RATES)).toHaveLength(1);
    expect(findPendingBills([{ ...quarterly, lastSeenAt: day("2026-08-10") }], MID_OCT, RATES)).toEqual([]);
    const annual = bill({ cadence: "annual", lastSeenAt: day("2025-10-02") });
    expect(findPendingBills([annual], MID_OCT, RATES)).toHaveLength(1);
    expect(findPendingBills([{ ...annual, lastSeenAt: day("2025-11-02") }], MID_OCT, RATES)).toEqual([]);
  });

  it("counts every charge still ahead for a weekly bill", () => {
    // Last charged Oct 10, every 7 days: Oct 17, 24 and 31 remain.
    const weekly = bill({ cadence: "weekly", averageIntervalDays: 7, lastSeenAt: day("2026-10-10"), currentNativeAmount: nativeAmount(-5_000) });
    const [found] = findPendingBills([weekly], MID_OCT, RATES);
    expect(found.occurrences).toBe(3);
    expect(found.totalAgorot).toBe(15_000);
  });

  it("counts one weekly charge that is late, then the ones still ahead", () => {
    const weekly = bill({ cadence: "weekly", averageIntervalDays: 7, lastSeenAt: day("2026-10-08"), currentNativeAmount: nativeAmount(-5_000) });
    const [found] = findPendingBills([weekly], MID_OCT, RATES);
    expect(found.occurrences).toBe(3);
    expect(found.overdue).toBe(true);
  });

  it("treats a weekly bill that has gone quiet for weeks as stopped", () => {
    const weekly = bill({ cadence: "weekly", averageIntervalDays: 7, lastSeenAt: day("2026-09-20") });
    expect(findPendingBills([weekly], MID_OCT, RATES)).toEqual([]);
  });

  it("converts a foreign-currency bill at the latest rate", () => {
    const usd = bill({ currency: "USD", currentNativeAmount: nativeAmount(-1_000), lastSeenAt: day("2026-09-25") });
    expect(findPendingBills([usd], MID_OCT, RATES)[0].totalAgorot).toBe(3_700);
  });

  it("lists the soonest bill first", () => {
    const late = bill({ merchantKey: "b", lastSeenAt: day("2026-09-28") });
    const early = bill({ merchantKey: "a", lastSeenAt: day("2026-09-18") });
    expect(findPendingBills([late, early], MID_OCT, RATES).map((b) => b.merchantKey)).toEqual(["a", "b"]);
  });
});

describe("computeGoalsDue", () => {
  const goal = (overrides: Partial<GoalInput> = {}): GoalInput => ({
    goalId: "g",
    name: "Trip",
    targetAgorot: a(300_000),
    currentAgorot: a(0),
    contributedThisMonthAgorot: a(0),
    targetDate: day("2026-12-20"),
    ...overrides,
  });

  it("spreads what is left evenly over the calendar months left, this one included", () => {
    const [due] = computeGoalsDue([goal()], MID_OCT);
    expect(due.monthsLeft).toBe(3);
    expect(due.requiredThisMonthAgorot).toBe(100_000);
    expect(due.dueAgorot).toBe(100_000);
  });

  it("rounds the monthly requirement up so the goal is never short", () => {
    const [due] = computeGoalsDue([goal({ targetAgorot: a(100_000) })], MID_OCT);
    expect(due.requiredThisMonthAgorot).toBe(33_334);
  });

  it("credits what has already been contributed this month without shrinking the requirement", () => {
    const paid = goal({ currentAgorot: a(100_000), contributedThisMonthAgorot: a(100_000) });
    expect(computeGoalsDue([paid], MID_OCT)[0]).toMatchObject({ requiredThisMonthAgorot: 100_000, dueAgorot: 0 });
    const half = goal({ currentAgorot: a(40_000), contributedThisMonthAgorot: a(40_000) });
    expect(computeGoalsDue([half], MID_OCT)[0].dueAgorot).toBe(60_000);
  });

  it("does not let an over-contribution this month go negative", () => {
    const ahead = goal({ currentAgorot: a(150_000), contributedThisMonthAgorot: a(150_000) });
    expect(computeGoalsDue([ahead], MID_OCT)[0].dueAgorot).toBe(0);
  });

  it("asks for more after a withdrawal this month", () => {
    const withdrew = goal({ currentAgorot: a(0), contributedThisMonthAgorot: a(-20_000) });
    const [due] = computeGoalsDue([withdrew], MID_OCT);
    expect(due.dueAgorot).toBeGreaterThan(100_000);
  });

  it("never asks for more than the goal still needs", () => {
    const almost = goal({ targetAgorot: a(300_000), currentAgorot: a(295_000), targetDate: day("2026-10-30"), contributedThisMonthAgorot: a(0) });
    expect(computeGoalsDue([almost], MID_OCT)[0].dueAgorot).toBe(5_000);
  });

  it("owes nothing for a goal with no date, one already reached, or one past its date", () => {
    expect(computeGoalsDue([goal({ targetDate: null })], MID_OCT)).toEqual([]);
    expect(computeGoalsDue([goal({ currentAgorot: a(300_000) })], MID_OCT)).toEqual([]);
    expect(computeGoalsDue([goal({ targetDate: day("2026-09-30") })], MID_OCT)).toEqual([]);
  });
});

function debt(overrides: Partial<DebtInput> = {}): DebtInput {
  return {
    debtId: "d1",
    name: "Student loan",
    balanceAgorot: a(2_000_000),
    minimumPaymentAgorot: a(40_000),
    paidThisMonthAgorot: a(0),
    ...overrides,
  };
}

describe("computeDebtsDue", () => {
  it("owes the whole minimum when nothing has been paid this month", () => {
    expect(computeDebtsDue([debt()], [])).toEqual([
      { debtId: "d1", name: "Student loan", minimumAgorot: 40_000, paidThisMonthAgorot: 0, dueAgorot: 40_000, handledByBill: null },
    ]);
  });

  it("credits what was already paid this month, and never goes negative on an overpayment", () => {
    expect(computeDebtsDue([debt({ paidThisMonthAgorot: a(15_000) })], [])[0].dueAgorot).toBe(25_000);
    expect(computeDebtsDue([debt({ paidThisMonthAgorot: a(40_000) })], [])[0].dueAgorot).toBe(0);
    expect(computeDebtsDue([debt({ paidThisMonthAgorot: a(90_000) })], [])[0].dueAgorot).toBe(0);
  });

  it("never asks for more than is left to owe", () => {
    const [due] = computeDebtsDue([debt({ balanceAgorot: a(12_000) })], []);
    expect(due.minimumAgorot).toBe(12_000);
    expect(due.dueAgorot).toBe(12_000);
  });

  it("skips a debt that is paid off or has no minimum", () => {
    expect(computeDebtsDue([debt({ balanceAgorot: a(0) }), debt({ debtId: "d2", minimumPaymentAgorot: a(0) })], [])).toEqual([]);
  });

  it("leaves a debt to the recurring bill that already is its repayment, so it is not counted twice", () => {
    const [due] = computeDebtsDue([debt({ name: "Student loan" })], ["Netflix", "Student Loan Payment"]);
    expect(due.dueAgorot).toBe(0);
    expect(due.handledByBill).toBe("Student Loan Payment");
    expect(due.minimumAgorot).toBe(40_000);
  });

  it("matches the other way round, when the bill is named inside the debt", () => {
    const [due] = computeDebtsDue([debt({ name: "Leumi mortgage payment" })], ["Leumi mortgage"]);
    expect(due.handledByBill).toBe("Leumi mortgage");
  });

  it("matches whole words only, so a different debt is not mistaken for the bill", () => {
    expect(computeDebtsDue([debt({ name: "Car" })], ["Carrefour"])[0].dueAgorot).toBe(40_000);
    expect(computeDebtsDue([debt({ name: "Loan" })], ["Mortgage"])[0].dueAgorot).toBe(40_000);
  });

  it("never links a very short name to a bill", () => {
    expect(computeDebtsDue([debt({ name: "A" })], ["A Bank payment"])[0].dueAgorot).toBe(40_000);
  });

  it("matches Hebrew names as whole words", () => {
    const [due] = computeDebtsDue([debt({ name: "הלוואה" })], ["הלוואה בנק לאומי"]);
    expect(due.handledByBill).toBe("הלוואה בנק לאומי");
  });
});

describe("computeSafeToSpend", () => {
  it("subtracts debt minimums still due, and is higher by exactly the payment once it is made", () => {
    const owing = safe({ cashAgorot: a(1_000_000), debtsDue: computeDebtsDue([debt()], []) });
    expect(owing.safeToSpendAgorot).toBe(960_000);
    expect(owing.debtDueAgorot).toBe(40_000);
    // Paying it takes the same amount out of cash and out of what is due: no change.
    const paid = safe({ cashAgorot: a(960_000), debtsDue: computeDebtsDue([debt({ paidThisMonthAgorot: a(40_000) })], []) });
    expect(paid.safeToSpendAgorot).toBe(960_000);
  });

  it("does not subtract a debt twice when a recurring bill already is its repayment", () => {
    const billsDue = [pending({ displayName: "Student loan payment", totalAgorot: a(40_000), amountEachAgorot: a(40_000) })];
    const result = safe({
      cashAgorot: a(1_000_000),
      pendingBills: billsDue,
      debtsDue: computeDebtsDue([debt()], ["Student loan payment"]),
    });
    expect(result.billsNotCoveredAgorot).toBe(40_000);
    expect(result.debtDueAgorot).toBe(0);
    expect(result.safeToSpendAgorot).toBe(960_000);
  });

  it("reports income still expected beside the figure, never inside it", () => {
    const withIncome = safe({
      cashAgorot: a(500_000),
      expectedIncome: [pending({ merchantKey: "salary", displayName: "Salary", totalAgorot: a(1_200_000), amountEachAgorot: a(1_200_000) })],
    });
    expect(withIncome.safeToSpendAgorot).toBe(500_000);
    expect(withIncome.expectedIncomeAgorot).toBe(1_200_000);
    expect(withIncome.safeToSpendWithExpectedIncomeAgorot).toBe(1_700_000);
  });

  it("reports no expected income, and the same figure either way, when there is none", () => {
    const result = safe({ cashAgorot: a(500_000) });
    expect(result.expectedIncomeAgorot).toBe(0);
    expect(result.safeToSpendWithExpectedIncomeAgorot).toBe(result.safeToSpendAgorot);
  });

  it("keeps a negative figure negative with expected income reported separately", () => {
    const result = safe({
      cashAgorot: a(100_000),
      pendingBills: [pending()],
      expectedIncome: [pending({ merchantKey: "salary", displayName: "Salary", totalAgorot: a(100_000), amountEachAgorot: a(100_000) })],
    });
    expect(result.safeToSpendAgorot).toBe(-300_000);
    expect(result.isOverCommitted).toBe(true);
    expect(result.safeToSpendWithExpectedIncomeAgorot).toBe(-200_000);
  });

  it("subtracts what is spoken for from cash, mid-month", () => {
    const result = safe({
      cashAgorot: a(1_000_000),
      cardOwedAgorot: a(150_000),
      envelopes: [envelope("groceries", 200_000)],
      pendingBills: [pending({ totalAgorot: a(400_000) })],
      goalsDue: computeGoalsDue(
        [{ goalId: "g", name: "Trip", targetAgorot: a(150_000), currentAgorot: a(0), contributedThisMonthAgorot: a(0), targetDate: day("2026-11-30") }],
        MID_OCT,
      ),
    });
    // 1,000,000 − 150,000 − 200,000 − 400,000 − 75,000
    expect(result.safeToSpendAgorot).toBe(175_000);
    expect(result.isOverCommitted).toBe(false);
    expect(result).toMatchObject({ envelopeReserveAgorot: 200_000, billsNotCoveredAgorot: 400_000, goalDueAgorot: 75_000 });
  });

  it("is higher by exactly the bill once the bill has been paid", () => {
    const base = { cashAgorot: a(1_000_000) };
    const withBill = safe({ ...base, pendingBills: [pending()] });
    // Paid: the charge left cash (that is in `cashAgorot`) and the bill is no longer pending.
    const paid = safe({ cashAgorot: a(1_000_000 - 400_000) });
    expect(withBill.safeToSpendAgorot).toBe(paid.safeToSpendAgorot);
  });

  it("does not deduct a bill again when its category's envelope already holds the money", () => {
    const result = safe({
      cashAgorot: a(1_000_000),
      envelopes: [envelope("rent", 450_000)],
      pendingBills: [pending({ categoryId: "rent", totalAgorot: a(400_000) })],
    });
    // The envelope (450,000) pays the bill (400,000): only the envelope is deducted.
    expect(result.safeToSpendAgorot).toBe(550_000);
    expect(result.billsNotCoveredAgorot).toBe(0);
    expect(result.bills[0]).toMatchObject({ coveredByEnvelopeAgorot: 400_000, deductedAgorot: 0 });
  });

  it("deducts only the part of a bill its envelope cannot cover", () => {
    const result = safe({
      cashAgorot: a(1_000_000),
      envelopes: [envelope("rent", 100_000)],
      pendingBills: [pending({ categoryId: "rent", totalAgorot: a(400_000) })],
    });
    expect(result.billsNotCoveredAgorot).toBe(300_000);
    expect(result.safeToSpendAgorot).toBe(1_000_000 - 100_000 - 300_000);
  });

  it("lets two bills in one category share its envelope, soonest first", () => {
    const result = safe({
      cashAgorot: a(1_000_000),
      envelopes: [envelope("home", 500_000)],
      pendingBills: [
        pending({ merchantKey: "rent", categoryId: "home", totalAgorot: a(400_000), dueDate: day("2026-10-20") }),
        pending({ merchantKey: "internet", categoryId: "home", totalAgorot: a(200_000), dueDate: day("2026-10-28") }),
      ],
    });
    expect(result.bills.map((b) => b.coveredByEnvelopeAgorot)).toEqual([400_000, 100_000]);
    expect(result.billsNotCoveredAgorot).toBe(100_000);
  });

  it("deducts a bill with no category, or in a category with no envelope, in full", () => {
    const result = safe({
      cashAgorot: a(1_000_000),
      envelopes: [envelope("groceries", 50_000)],
      pendingBills: [pending({ categoryId: null, totalAgorot: a(10_000) }), pending({ categoryId: "phone", totalAgorot: a(20_000) })],
    });
    expect(result.billsNotCoveredAgorot).toBe(30_000);
  });

  describe("an overspent envelope", () => {
    it("contributes nothing instead of adding its negative balance back", () => {
      const overspent = safe({ cashAgorot: a(800_000), envelopes: [envelope("dining", -30_000)] });
      const balanced = safe({ cashAgorot: a(800_000), envelopes: [envelope("dining", 0)] });
      expect(overspent.envelopeReserveAgorot).toBe(0);
      expect(overspent.safeToSpendAgorot).toBe(balanced.safeToSpendAgorot);
      // Subtracting the signed balance would give 830,000: overspending must never help.
      expect(overspent.safeToSpendAgorot).toBeLessThan(830_000);
    });

    it("lowers Safe to Spend by exactly the overspend, because the money has left cash", () => {
      // 1,000,000 in checking; a 100,000 envelope allocated.
      const checking = (balance: number) => settleAccounts([{ accountType: "CHECKING", balanceAgorot: a(balance) }]);
      const before = safe({
        ...checking(1_000_000),
        envelopes: [envelope("dining", 100_000)],
      });
      // Spend inside the envelope: the reserve shrinks as cash does, so nothing changes.
      const insideEnvelope = safe({
        ...checking(1_000_000 - 100_000),
        envelopes: [envelope("dining", 0)],
      });
      // Spend 130,000: 30,000 more than was allocated.
      const overspent = safe({
        ...checking(1_000_000 - 130_000),
        envelopes: [envelope("dining", -30_000)],
      });
      expect(insideEnvelope.safeToSpendAgorot).toBe(before.safeToSpendAgorot);
      expect(overspent.safeToSpendAgorot).toBe(before.safeToSpendAgorot - 30_000);
    });

    it("lists every overspent envelope, largest first, and none that is in credit", () => {
      const result = safe({ envelopes: [envelope("misc", -5_000), envelope("dining", -30_000), envelope("groceries", 20_000)] });
      expect(result.overspentEnvelopes.map((e) => [e.categoryId, e.overspentAgorot])).toEqual([
        ["dining", 30_000],
        ["misc", 5_000],
      ]);
    });
  });

  describe("transfers between the user's own accounts", () => {
    it("leave Safe to Spend unchanged when both legs are recorded", () => {
      // Paying the card from checking: checking −500,000 and the card's debt −500,000.
      const before = settleAccounts([
        { accountType: "CHECKING", balanceAgorot: a(2_000_000) },
        { accountType: "CREDIT_CARD", balanceAgorot: a(500_000) },
      ]);
      const after = settleAccounts([
        { accountType: "CHECKING", balanceAgorot: a(1_500_000) },
        { accountType: "CREDIT_CARD", balanceAgorot: a(0) },
      ]);
      expect(safe(after).safeToSpendAgorot).toBe(safe(before).safeToSpendAgorot);
    });

    it("leave Safe to Spend unchanged when moving money between checking and savings", () => {
      const settle = (checking: number, savings: number) =>
        settleAccounts([
          { accountType: "CHECKING", balanceAgorot: a(1_000_000 + checking) },
          { accountType: "SAVINGS", balanceAgorot: a(1_000_000 + savings) },
        ]);
      expect(safe(settle(-300_000, 300_000)).safeToSpendAgorot).toBe(safe(settle(0, 0)).safeToSpendAgorot);
    });
  });

  describe("a negative result", () => {
    it("is reported as negative and flagged, never clamped to zero", () => {
      const result = safe({
        cashAgorot: a(100_000),
        pendingBills: [pending({ totalAgorot: a(400_000) })],
      });
      expect(result.safeToSpendAgorot).toBe(-300_000);
      expect(result.isOverCommitted).toBe(true);
    });

    it("grows more negative as an overdraft deepens", () => {
      const shallow = safe({ cashAgorot: a(-10_000), cardOwedAgorot: a(50_000) });
      const deep = safe({ cashAgorot: a(-60_000), cardOwedAgorot: a(50_000) });
      expect(shallow.safeToSpendAgorot).toBe(-60_000);
      expect(deep.safeToSpendAgorot).toBe(-110_000);
    });

    it("is not over-committed at exactly zero", () => {
      const result = safe({ cashAgorot: a(400_000), pendingBills: [pending({ totalAgorot: a(400_000) })] });
      expect(result.safeToSpendAgorot).toBe(0);
      expect(result.isOverCommitted).toBe(false);
    });
  });

  it("returns the whole breakdown so the figure can be explained line by line", () => {
    const result = safe({ cashAgorot: a(500_000), cardOwedAgorot: a(100_000) });
    expect(result).toMatchObject({ cashAgorot: 500_000, cardOwedAgorot: 100_000, envelopeReserveAgorot: 0, billsNotCoveredAgorot: 0, goalDueAgorot: 0 });
    expect(result.safeToSpendAgorot).toBe(400_000);
  });
});
