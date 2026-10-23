import { describe, expect, it } from "vitest";
import { matchDebtPayments, matchedPaidInPeriod, type DebtRef, type LedgerRow } from "./debt-payment-matching";

const day = (iso: string) => new Date(`${iso}T12:00:00Z`);
const debt = (id: string, name: string, createdIso = "2026-01-01"): DebtRef => ({ id, name, createdAt: day(createdIso) });
let n = 0;
const row = (label: string, iso: string, amount: number): LedgerRow => ({ id: `t${++n}`, occurredAt: day(iso), amountAgorot: amount, label });

describe("matchDebtPayments", () => {
  it("matches an expense whose name fits the debt, with the amount as a positive figure", () => {
    const r = row("VOLKSWAGEN FINANCE PAYMENT", "2026-10-05", -250_000);
    expect(matchDebtPayments([debt("d1", "Volkswagen Finance car loan")], [r])).toEqual([
      { debtId: "d1", transactionId: r.id, occurredAt: r.occurredAt, amountAgorot: 250_000, label: r.label },
    ]);
  });

  it("ignores income, zero, blank labels and unrelated merchants", () => {
    const debts = [debt("d1", "Volkswagen Finance")];
    expect(matchDebtPayments(debts, [row("Volkswagen Finance", "2026-10-05", 250_000), row("Volkswagen Finance", "2026-10-05", 0), row("  ", "2026-10-05", -5), row("Supermarket", "2026-10-05", -5)])).toEqual([]);
  });

  it("ignores a payment dated before the debt was added: its balance already holds it", () => {
    const debts = [debt("d1", "Volkswagen Finance", "2026-10-10")];
    expect(matchDebtPayments(debts, [row("Volkswagen Finance", "2026-10-09", -1_000)])).toEqual([]);
    expect(matchDebtPayments(debts, [row("Volkswagen Finance", "2026-10-10", -1_000)])).toHaveLength(1);
  });

  it("skips a row that fits two debts rather than guessing", () => {
    // Both debts are with the same bank, so "Leumi" alone fits both.
    const debts = [debt("d1", "Leumi car loan"), debt("d2", "Leumi mortgage")];
    expect(matchDebtPayments(debts, [row("Leumi payment", "2026-10-05", -1_000)])).toEqual([]);
    // A row that fits only one debt is matched.
    const other = [debt("d1", "Volkswagen loan"), debt("d2", "Nissan mortgage")];
    expect(matchDebtPayments(other, [row("Nissan mortgage instalment", "2026-10-05", -1_000)]).map((m) => m.debtId)).toEqual(["d2"]);
  });

  it("returns the oldest first", () => {
    const matches = matchDebtPayments([debt("d1", "Volkswagen Finance")], [row("Volkswagen Finance", "2026-10-20", -1), row("Volkswagen Finance", "2026-09-20", -2)]);
    expect(matches.map((m) => m.amountAgorot)).toEqual([2, 1]);
  });
});

describe("matchedPaidInPeriod", () => {
  it("adds up what each debt was paid inside the period, the end exclusive", () => {
    const matches = matchDebtPayments(
      [debt("d1", "Volkswagen loan"), debt("d2", "Nissan lease")],
      [
        row("Volkswagen loan", "2026-09-30", -100),
        row("Volkswagen loan", "2026-10-01", -200),
        row("Volkswagen loan", "2026-10-31", -300),
        row("Nissan lease", "2026-10-15", -400),
        row("Nissan lease", "2026-11-01", -500),
      ],
    );
    const paid = matchedPaidInPeriod(matches, new Date("2026-10-01T00:00:00Z"), new Date("2026-11-01T00:00:00Z"));
    expect(paid.get("d1")).toBe(500);
    expect(paid.get("d2")).toBe(400);
  });
});
