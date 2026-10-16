import { describe, expect, it } from "vitest";
import { nativeAmount } from "../currency";
import { describeMismatches, reconcileStatement, type ReconcilableRow } from "./reconcile";

function rows(...entries: [line: number, amount: number, balance: number | null][]): ReconcilableRow[] {
  return entries.map(([lineNumber, amount, balance]) => ({
    lineNumber,
    nativeAmount: nativeAmount(amount),
    printedBalance: balance === null ? null : nativeAmount(balance),
  }));
}

const OPENING = nativeAmount(10_000);

describe("reconcileStatement", () => {
  it("does not claim a check it cannot do when the file has no balance column", () => {
    expect(reconcileStatement(rows([2, -500, null], [3, 200, null]), null)).toEqual({ status: "not-checked", reason: "no-balance-column" });
    expect(reconcileStatement([], null)).toEqual({ status: "not-checked", reason: "no-balance-column" });
  });

  it("reconciles a chain that starts from the opening balance, checking every row", () => {
    const report = reconcileStatement(rows([2, -2_500, 7_500], [3, 1_000, 8_500], [4, -8_500, 0]), OPENING);
    expect(report).toEqual({
      status: "reconciled",
      order: "oldest-first",
      checkedRows: 3,
      openingBalance: 10_000,
      closingBalance: 0,
      total: -10_000,
      totalMatches: true,
      mismatches: [],
    });
  });

  it("without an opening balance, checks every row but the first, and makes no claim about the total", () => {
    const report = reconcileStatement(rows([2, -2_500, 7_500], [3, 1_000, 8_500]), null);
    expect(report).toMatchObject({ status: "reconciled", checkedRows: 1, totalMatches: null });
  });

  it("names a dropped row at the line after it, off by exactly the missing amount", () => {
    // The -1,000 row that should sit between lines 3 and 4 is gone.
    const report = reconcileStatement(rows([2, -2_500, 7_500], [3, 1_000, 8_500], [4, -500, 7_000]), OPENING);
    expect(report.status).toBe("mismatch");
    if (report.status !== "mismatch") return;
    expect(report.mismatches).toEqual([
      expect.objectContaining({ lineNumber: 4, previousBalance: 8_500, amount: -500, expectedBalance: 8_000, printedBalance: 7_000, difference: -1_000 }),
    ]);
    expect(report.mismatches[0].hint).toMatch(/1000 minor units are unaccounted for between line 3 and this line/);
    expect(report.totalMatches).toBe(false);
  });

  it("reports one bad row once, not every row after it", () => {
    const report = reconcileStatement(rows([2, -9_999, 7_500], [3, 1_000, 8_500], [4, 500, 9_000], [5, -9_000, 0]), OPENING);
    expect(report.status === "mismatch" && report.mismatches.map((m) => m.lineNumber)).toEqual([2]);
  });

  it("recognises an inverted sign", () => {
    const report = reconcileStatement(rows([2, 2_500, 7_500]), OPENING);
    expect(report.status === "mismatch" && report.mismatches[0].hint).toBe("the amount's sign looks inverted");
  });

  it("recognises an amount read 100 times too small or too large", () => {
    const tooSmall = reconcileStatement(rows([2, -25, 7_500]), OPENING);
    expect(tooSmall.status === "mismatch" && tooSmall.mismatches[0].hint).toMatch(/100 times too small/);
    const tooLarge = reconcileStatement(rows([2, -250_000, 7_500]), OPENING);
    expect(tooLarge.status === "mismatch" && tooLarge.mismatches[0].hint).toMatch(/100 times too large/);
  });

  it("recognises a row that moved nothing, such as a duplicate", () => {
    const report = reconcileStatement(rows([2, -2_500, 7_500], [3, -2_500, 7_500]), OPENING);
    expect(report.status === "mismatch" && report.mismatches[0].hint).toMatch(/should not have moved the balance, or it is a duplicate/);
  });

  it("blames a rejected line when one sits in the gap", () => {
    const report = reconcileStatement(rows([2, -2_500, 7_500], [4, -500, 6_000]), OPENING, [
      { lineNumber: 3, message: 'date "31.02.2026" is not a real date' },
    ]);
    expect(report.status === "mismatch" && report.mismatches[0].hint).toBe(
      'a row before this one was rejected, so its amount is missing from the chain: line 3 (date "31.02.2026" is not a real date)',
    );
  });

  it("treats a missing balance cell on a statement that prints balances as a failure, not a skip", () => {
    const report = reconcileStatement(rows([2, -2_500, 7_500], [3, 1_000, null], [4, -500, 8_000]), OPENING);
    expect(report.status).toBe("mismatch");
    expect(report.status === "mismatch" && report.mismatches[0]).toMatchObject({ lineNumber: 3 });
    expect(report.status === "mismatch" && report.mismatches[0].hint).toMatch(/no printed balance/);
  });

  it("works out a newest-first statement from the arithmetic, not the dates", () => {
    // Newest first: each row's balance is the next (older) row's balance plus this row's amount.
    const report = reconcileStatement(rows([2, -500, 8_000], [3, 1_000, 8_500], [4, -2_500, 7_500]), null);
    expect(report).toMatchObject({ status: "reconciled", order: "newest-first", checkedRows: 2, closingBalance: 8_000, totalMatches: null });
  });

  it("only reads oldest-first when an opening balance was printed", () => {
    const report = reconcileStatement(rows([2, -500, 8_000], [3, 1_000, 8_500], [4, -2_500, 7_500]), OPENING);
    expect(report).toMatchObject({ status: "mismatch", order: "oldest-first" });
  });
});

describe("describeMismatches", () => {
  it("writes one line per disagreeing row with the arithmetic, and the whole-statement total", () => {
    const report = reconcileStatement(rows([2, -2_500, 7_500], [3, 1_000, 8_500], [4, -500, 7_000]), OPENING);
    expect(describeMismatches(report)).toBe(
      [
        "  line 4: previous balance 8500 + amount -500 = 8000, but the statement prints 7000 (off by -1000) — 1000 minor units are unaccounted for between line 3 and this line: a row may have been dropped, merged into another, or misread",
        "  whole statement: opening 10000 + parsed total -2000 = 8000, but it closes at 7000",
      ].join("\n"),
    );
  });

  it("caps a long list and says how many more there are", () => {
    const many = rows(...Array.from({ length: 8 }, (_, index): [number, number, number] => [index + 2, -1, 999_999]));
    const text = describeMismatches(reconcileStatement(many, OPENING), 3);
    expect(text.split("\n").filter((line) => line.startsWith("  line"))).toHaveLength(3);
    expect(text).toContain("…and 5 more");
  });

  it("is empty for a statement that reconciles", () => {
    expect(describeMismatches(reconcileStatement(rows([2, -2_500, 7_500]), OPENING))).toBe("");
  });
});
