import { describe, expect, it } from "vitest";
import {
  buildManualBillRows,
  dueDateInMonth,
  findPayment,
  isManualBillKey,
  minorUnitsToInputText,
  manualBillIdFromKey,
  manualBillKey,
  namesMatch,
  nextDueOnOrAfter,
  type LedgerExpense,
  type RecurringBillInput,
} from "./recurring-bills";
import { findPendingBills } from "./safe-to-spend";

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const RATES = { ILS: 1, USD: 3.5, EUR: 4, GBP: 4.7, TRY: 0.1 } as const;

function bill(overrides: Partial<RecurringBillInput> = {}): RecurringBillInput {
  return {
    id: "b1",
    name: "Netflix",
    nativeAmount: 5_000,
    currency: "ILS",
    cadence: "monthly",
    anchorDate: day("2026-07-12"),
    categoryId: null,
    ...overrides,
  };
}

function charge(name: string, iso: string, amount: number, currency: LedgerExpense["currency"] = "ILS"): LedgerExpense {
  return { displayName: name, currency, nativeAmount: amount, occurredAt: day(iso) };
}

describe("dueDateInMonth", () => {
  it("puts a monthly bill on its anchor day in every month from the anchor on", () => {
    const b = bill({ anchorDate: day("2026-07-12") });
    expect(dueDateInMonth(b, 2026, 6)).toEqual(day("2026-07-12"));
    expect(dueDateInMonth(b, 2026, 9)).toEqual(day("2026-10-12"));
    expect(dueDateInMonth(b, 2027, 0)).toEqual(day("2027-01-12"));
  });

  it("is not due before its anchor month", () => {
    expect(dueDateInMonth(bill({ anchorDate: day("2026-07-12") }), 2026, 5)).toBeNull();
  });

  it("shortens the 31st to the last day of a shorter month", () => {
    const b = bill({ anchorDate: day("2026-01-31") });
    expect(dueDateInMonth(b, 2026, 1)).toEqual(day("2026-02-28"));
    expect(dueDateInMonth(b, 2028, 1)).toEqual(day("2028-02-29")); // leap year
    expect(dueDateInMonth(b, 2026, 3)).toEqual(day("2026-04-30"));
    expect(dueDateInMonth(b, 2026, 2)).toEqual(day("2026-03-31"));
  });

  it("puts a quarterly bill only every third month", () => {
    const b = bill({ cadence: "quarterly", anchorDate: day("2026-01-15") });
    expect(dueDateInMonth(b, 2026, 0)).toEqual(day("2026-01-15"));
    expect(dueDateInMonth(b, 2026, 1)).toBeNull();
    expect(dueDateInMonth(b, 2026, 2)).toBeNull();
    expect(dueDateInMonth(b, 2026, 3)).toEqual(day("2026-04-15"));
    expect(dueDateInMonth(b, 2026, 9)).toEqual(day("2026-10-15"));
  });

  it("puts a yearly bill only in its anchor month each year", () => {
    const b = bill({ cadence: "annual", anchorDate: day("2025-11-03") });
    expect(dueDateInMonth(b, 2025, 10)).toEqual(day("2025-11-03"));
    expect(dueDateInMonth(b, 2026, 9)).toBeNull();
    expect(dueDateInMonth(b, 2026, 10)).toEqual(day("2026-11-03"));
    expect(dueDateInMonth(b, 2027, 10)).toEqual(day("2027-11-03"));
  });
});

describe("nextDueOnOrAfter", () => {
  it("finds the same day when it is due today", () => {
    expect(nextDueOnOrAfter(bill({ anchorDate: day("2026-07-12") }), day("2026-10-12"))).toEqual(day("2026-10-12"));
  });

  it("rolls into next month when this month's day has passed", () => {
    expect(nextDueOnOrAfter(bill({ anchorDate: day("2026-07-12") }), day("2026-10-13"))).toEqual(day("2026-11-12"));
  });

  it("rolls into the next year for a yearly bill", () => {
    expect(nextDueOnOrAfter(bill({ cadence: "annual", anchorDate: day("2025-03-01") }), day("2026-03-02"))).toEqual(day("2027-03-01"));
  });

  it("starts at the anchor when the anchor is in the future", () => {
    expect(nextDueOnOrAfter(bill({ anchorDate: day("2027-02-10") }), day("2026-10-01"))).toEqual(day("2027-02-10"));
  });
});

describe("namesMatch", () => {
  it("matches the same name after normalization", () => {
    expect(namesMatch("Netflix", "NETFLIX")).toBe(true);
    expect(namesMatch("Netflix", "SQ *Netflix 123456")).toBe(true);
  });

  it("matches on a distinctive shared word", () => {
    expect(namesMatch("Claude Pro", "CLAUDE.AI SUBSCRIPTION")).toBe(true);
    expect(namesMatch("YouTube Premium", "GOOGLE *YOUTUBEPREMIUM")).toBe(false); // no shared whole word: honest limit
    expect(namesMatch("YouTube Premium", "YouTube Music Premium")).toBe(true);
  });

  it("does not match on a generic word alone", () => {
    expect(namesMatch("Phone bill", "Water bill")).toBe(false);
    expect(namesMatch("Gym membership", "Library membership")).toBe(false);
    expect(namesMatch("Spotify Premium", "Netflix Premium")).toBe(false);
  });

  it("does not match unrelated names or empty ones", () => {
    expect(namesMatch("Rent", "Supermarket")).toBe(false);
    expect(namesMatch("", "Netflix")).toBe(false);
  });
});

describe("findPayment", () => {
  const due = day("2026-10-12");

  it("finds a matching charge close to the due date", () => {
    const paid = charge("NETFLIX.COM", "2026-10-13", -5_000);
    expect(findPayment(bill(), due, [paid])).toBe(paid);
  });

  it("accepts a price change within the tolerance and refuses a much bigger one", () => {
    expect(findPayment(bill(), due, [charge("Netflix", "2026-10-12", -6_500)])).not.toBeNull();
    expect(findPayment(bill(), due, [charge("Netflix", "2026-10-12", -50_000)])).toBeNull();
  });

  it("ignores income, a different merchant and a charge from another cycle", () => {
    expect(findPayment(bill(), due, [charge("Netflix", "2026-10-12", 5_000)])).toBeNull();
    expect(findPayment(bill(), due, [charge("Supermarket", "2026-10-12", -5_000)])).toBeNull();
    expect(findPayment(bill(), due, [charge("Netflix", "2026-09-12", -5_000)])).toBeNull();
    expect(findPayment(bill(), due, [charge("Netflix", "2026-11-12", -5_000)])).toBeNull();
  });

  it("counts a charge paid up to ten days early and fifteen days late, not beyond", () => {
    expect(findPayment(bill(), due, [charge("Netflix", "2026-10-02", -5_000)])).not.toBeNull();
    expect(findPayment(bill(), due, [charge("Netflix", "2026-10-01", -5_000)])).toBeNull();
    expect(findPayment(bill(), due, [charge("Netflix", "2026-10-26", -5_000)])).not.toBeNull();
    expect(findPayment(bill(), due, [charge("Netflix", "2026-10-27", -5_000)])).toBeNull();
  });

  it("does not compare amounts across currencies: a dollar bill billed in lira still counts", () => {
    const dollar = bill({ name: "Claude Pro", currency: "USD", nativeAmount: 2_000 });
    expect(findPayment(dollar, due, [charge("CLAUDE.AI SUBSCRIPTION", "2026-10-12", -91_000, "TRY")])).not.toBeNull();
  });

  it("picks the charge closest to the due date", () => {
    const near = charge("Netflix", "2026-10-12", -5_000);
    const far = charge("Netflix", "2026-10-20", -5_000);
    expect(findPayment(bill(), due, [far, near])).toBe(near);
  });
});

describe("buildManualBillRows", () => {
  const asOf = new Date("2026-10-16T09:00:00Z");

  it("makes an unpaid bill due later this month pending on its due day", () => {
    const { rows } = buildManualBillRows([bill({ anchorDate: day("2026-07-25") })], [], [], asOf);
    const pending = findPendingBills(rows.map((row) => ({ ...row, status: "ACTIVE" as const })), asOf, RATES);
    expect(pending).toHaveLength(1);
    expect(pending[0].dueDate).toEqual(day("2026-10-25"));
    expect(pending[0].overdue).toBe(false);
    expect(pending[0].amountEachAgorot).toBe(5_000);
  });

  it("keeps an unpaid bill whose day has passed pending and flags it overdue: late is not paid", () => {
    const { rows } = buildManualBillRows([bill({ anchorDate: day("2026-07-05") })], [], [], asOf);
    const pending = findPendingBills(rows.map((row) => ({ ...row, status: "ACTIVE" as const })), asOf, RATES);
    expect(pending).toHaveLength(1);
    expect(pending[0].dueDate).toEqual(day("2026-10-05"));
    expect(pending[0].overdue).toBe(true);
  });

  it("is not pending once this month's charge has appeared in the ledger", () => {
    const ledger = [charge("NETFLIX.COM", "2026-10-05", -5_000)];
    const { rows } = buildManualBillRows([bill({ anchorDate: day("2026-07-05") })], ledger, [], asOf);
    expect(findPendingBills(rows.map((row) => ({ ...row, status: "ACTIVE" as const })), asOf, RATES)).toHaveLength(0);
  });

  it("is not pending in a month it is not due", () => {
    // Feb, May, Aug, Nov: October is not one of them.
    const { rows } = buildManualBillRows([bill({ cadence: "quarterly", anchorDate: day("2026-02-15") })], [], [], asOf);
    expect(findPendingBills(rows.map((row) => ({ ...row, status: "ACTIVE" as const })), asOf, RATES)).toHaveLength(0);
  });

  it("is pending in a month a quarterly bill is due", () => {
    // Jan, Apr, Jul, Oct: October is one of them, and the 15th has passed unpaid.
    const { rows } = buildManualBillRows([bill({ cadence: "quarterly", anchorDate: day("2026-01-15") })], [], [], asOf);
    const pending = findPendingBills(rows.map((row) => ({ ...row, status: "ACTIVE" as const })), asOf, RATES);
    expect(pending).toHaveLength(1);
    expect(pending[0].dueDate).toEqual(day("2026-10-15"));
  });

  it("is not pending before its anchor month", () => {
    const { rows } = buildManualBillRows([bill({ anchorDate: day("2026-12-01") })], [], [], asOf);
    expect(findPendingBills(rows.map((row) => ({ ...row, status: "ACTIVE" as const })), asOf, RATES)).toHaveLength(0);
  });

  it("lands a bill anchored on the 31st on the last day of a short month", () => {
    const feb = new Date("2027-02-10T09:00:00Z");
    const { rows } = buildManualBillRows([bill({ anchorDate: day("2026-10-31") })], [], [], feb);
    const pending = findPendingBills(rows.map((row) => ({ ...row, status: "ACTIVE" as const })), feb, RATES);
    expect(pending[0].dueDate).toEqual(day("2027-02-28"));
  });

  it("is superseded once the radar has detected the same subscription, and not counted twice", () => {
    const detected = [{ displayName: "NETFLIX.COM", isRecurring: true }];
    const { rows, superseded } = buildManualBillRows([bill()], [], detected, asOf);
    expect(rows).toHaveLength(0);
    expect(superseded).toEqual([{ bill: bill(), detectedAs: "NETFLIX.COM" }]);
  });

  it("is not superseded by a detected charge that is not recurring", () => {
    const detected = [{ displayName: "NETFLIX.COM", isRecurring: false }];
    expect(buildManualBillRows([bill()], [], detected, asOf).rows).toHaveLength(1);
  });

  it("shows next month's date for a bill already paid this month", () => {
    const ledger = [charge("Netflix", "2026-10-20", -5_000)];
    const { rows } = buildManualBillRows([bill({ anchorDate: day("2026-07-20") })], ledger, [], asOf);
    expect(rows[0].nextExpectedDate).toEqual(day("2026-11-20"));
  });

  it("shows the date still to come for an unpaid bill", () => {
    const { rows } = buildManualBillRows([bill({ anchorDate: day("2026-07-20") })], [], [], asOf);
    expect(rows[0].nextExpectedDate).toEqual(day("2026-10-20"));
  });

  it("converts a foreign bill at the latest rate when it is pending", () => {
    const dollar = bill({ name: "Claude Pro", currency: "USD", nativeAmount: 2_000, anchorDate: day("2026-07-25") });
    const { rows } = buildManualBillRows([dollar], [], [], asOf);
    const pending = findPendingBills(rows.map((row) => ({ ...row, status: "ACTIVE" as const })), asOf, RATES);
    expect(pending[0].amountEachAgorot).toBe(7_000); // $20.00 at 3.5
  });

  it("carries the bill's id, category and a tracking key that cancel and review can use", () => {
    const { rows } = buildManualBillRows([bill({ id: "abc", categoryId: "cat-1" })], [], [], asOf);
    expect(rows[0]).toMatchObject({ manualBillId: "abc", categoryId: "cat-1", merchantKey: "manual:abc", isRecurring: true, cadence: "monthly" });
  });
});

describe("manual bill keys", () => {
  it("round-trips an id and recognizes only its own keys", () => {
    expect(manualBillKey("abc")).toBe("manual:abc");
    expect(isManualBillKey("manual:abc")).toBe(true);
    expect(isManualBillKey("netflix")).toBe(false);
    expect(manualBillIdFromKey("manual:abc")).toBe("abc");
    expect(manualBillIdFromKey("netflix")).toBeNull();
  });
});

describe("minorUnitsToInputText", () => {
  it("writes minor units as the text typed into the amount field", () => {
    expect(minorUnitsToInputText(4_990)).toBe("49.90");
    expect(minorUnitsToInputText(5)).toBe("0.05");
    expect(minorUnitsToInputText(100)).toBe("1.00");
    expect(minorUnitsToInputText(123_456_789)).toBe("1234567.89");
  });
});
