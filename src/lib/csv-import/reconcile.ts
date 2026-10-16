import type { NativeAmount } from "../currency";

/**
 * Proves a parsed statement is exact, using the bank's own arithmetic.
 *
 * A statement that prints a running balance has already done the sum: each
 * row's balance is the previous balance plus that row's amount. If every
 * parsed row satisfies that, no row was dropped, duplicated, split in two,
 * mis-signed or misread — any of those breaks the chain at the exact line it
 * happened. That is a stronger check than counting rows, and it needs no
 * knowledge of the layout: it is what makes a PDF reconstruction (geometry,
 * page breaks, wrapped descriptions) safe to trust.
 *
 * Pure, like the rest of the pipeline. Amounts are compared as integers in
 * minor units, never floats.
 */

export type ReconcilableRow = {
  lineNumber: number;
  nativeAmount: NativeAmount;
  /** The balance the statement prints AFTER this row, or null when the row has none. */
  printedBalance: NativeAmount | null;
};

export type ReconciliationMismatch = {
  lineNumber: number;
  /** The balance this row should have started from (the previous row's printed balance, or the opening balance). */
  previousBalance: number;
  amount: number;
  /** previousBalance + amount */
  expectedBalance: number;
  printedBalance: number;
  /** printedBalance − expectedBalance: the amount the parse is off by at this line. */
  difference: number;
  /** The most likely cause, in plain words. */
  hint: string;
};

export type StatementOrder = "oldest-first" | "newest-first";

type CheckedReport = {
  order: StatementOrder;
  /** Rows whose balance was checked against the one before (the first row can only be checked against an opening balance). */
  checkedRows: number;
  openingBalance: number | null;
  closingBalance: number;
  /** Sum of every parsed amount. */
  total: number;
  /** opening + total = closing, when the statement printed an opening balance. */
  totalMatches: boolean | null;
  mismatches: ReconciliationMismatch[];
};

export type ReconciledReport = CheckedReport & { status: "reconciled" };
export type MismatchReport = CheckedReport & { status: "mismatch" };
export type ReconciliationReport =
  | { status: "not-checked"; reason: "no-balance-column" }
  | ReconciledReport
  | MismatchReport;

/** Lines the parser rejected, with why, so a gap in the chain can be explained by the line that fell out of it. */
export type RejectedLine = { lineNumber: number; message: string };

function hintFor(
  mismatch: Omit<ReconciliationMismatch, "hint">,
  rejectedBetween: readonly RejectedLine[],
  previousLine: number | null,
): string {
  const { amount, difference, previousBalance, printedBalance } = mismatch;
  if (rejectedBetween.length > 0) {
    const lines = rejectedBetween
      .map((line) => `line ${line.lineNumber} (${line.message})`)
      .join("; ");
    return `a row before this one was rejected, so its amount is missing from the chain: ${lines}`;
  }
  if (amount !== 0 && difference === -2 * amount)
    return "the amount's sign looks inverted";
  if (amount !== 0 && printedBalance - previousBalance === amount * 100)
    return "the amount looks 100 times too small (a decimal separator misread)";
  if (amount !== 0 && (printedBalance - previousBalance) * 100 === amount)
    return "the amount looks 100 times too large (a decimal separator misread)";
  if (printedBalance - previousBalance === 0)
    return "this row should not have moved the balance, or it is a duplicate of a row that already did";
  const after =
    previousLine === null ? "the opening balance" : `line ${previousLine}`;
  return `${Math.abs(difference)} minor units are unaccounted for between ${after} and this line: a row may have been dropped, merged into another, or misread`;
}

function check(
  rows: readonly ReconcilableRow[],
  openingBalance: number | null,
  rejected: readonly RejectedLine[],
): { mismatches: ReconciliationMismatch[]; checkedRows: number } {
  const mismatches: ReconciliationMismatch[] = [];
  let checkedRows = 0;
  let previous: number | null = openingBalance;
  let previousLine: number | null = null;

  for (const row of rows) {
    if (row.printedBalance === null) {
      // A statement that prints balances prints one on every transaction;
      // a row without one is itself a sign the reconstruction went wrong.
      mismatches.push({
        lineNumber: row.lineNumber,
        previousBalance: previous ?? 0,
        amount: row.nativeAmount,
        expectedBalance: (previous ?? 0) + row.nativeAmount,
        printedBalance: Number.NaN,
        difference: Number.NaN,
        hint: "this row has no printed balance, though the statement prints one on every row: its balance cell was lost or merged into another row",
      });
      previous = null;
      previousLine = row.lineNumber;
      continue;
    }

    if (previous !== null) {
      checkedRows += 1;
      const expected = previous + row.nativeAmount;
      if (expected !== row.printedBalance) {
        const lowerLine = previousLine ?? 0;
        const rejectedBetween = rejected.filter(
          (line) =>
            line.lineNumber > lowerLine && line.lineNumber < row.lineNumber,
        );
        const base = {
          lineNumber: row.lineNumber,
          previousBalance: previous,
          amount: row.nativeAmount,
          expectedBalance: expected,
          printedBalance: row.printedBalance,
          difference: row.printedBalance - expected,
        };
        mismatches.push({
          ...base,
          hint: hintFor(base, rejectedBetween, previousLine),
        });
      }
    }
    // Continue from what the bank printed, so one bad row is reported once
    // instead of throwing every later row off by the same amount.
    previous = row.printedBalance;
    previousLine = row.lineNumber;
  }
  return { mismatches, checkedRows };
}

/**
 * Checks `rows` (in the order they appear in the file) against their printed
 * running balance.
 *
 * Most statements list the oldest movement first; some list the newest first.
 * The order is never guessed from dates (one day can hold many rows): both
 * are tried, and the one the bank's own arithmetic agrees with wins. An
 * opening balance only makes sense oldest-first, so when one was printed the
 * oldest-first reading is the only one considered.
 */
export function reconcileStatement(
  rows: readonly ReconcilableRow[],
  openingBalance: NativeAmount | null,
  rejected: readonly RejectedLine[] = [],
): ReconciliationReport {
  if (rows.length === 0 || rows.every((row) => row.printedBalance === null)) {
    return { status: "not-checked", reason: "no-balance-column" };
  }

  const total = rows.reduce((sum, row) => sum + row.nativeAmount, 0);

  const forward = check(rows, openingBalance, rejected);
  let order: StatementOrder = "oldest-first";
  let result = forward;
  if (openingBalance === null && forward.mismatches.length > 0) {
    const backward = check([...rows].reverse(), null, rejected);
    if (backward.mismatches.length < forward.mismatches.length) {
      order = "newest-first";
      result = {
        ...backward,
        mismatches: [...backward.mismatches].sort(
          (a, b) => a.lineNumber - b.lineNumber,
        ),
      };
    }
  }

  const closingRow = order === "oldest-first" ? rows[rows.length - 1] : rows[0];
  const closingBalance = closingRow.printedBalance ?? Number.NaN;
  const totalMatches =
    openingBalance === null ? null : openingBalance + total === closingBalance;

  // A chain can only hide an error if the rows were checked pairwise and the
  // ends still disagree, so the whole-file total is its own failure too.
  const failed = result.mismatches.length > 0 || totalMatches === false;
  const checked: CheckedReport = {
    order,
    checkedRows: result.checkedRows,
    openingBalance,
    closingBalance,
    total,
    totalMatches,
    mismatches: result.mismatches,
  };
  return failed
    ? { ...checked, status: "mismatch" }
    : { ...checked, status: "reconciled" };
}

/** A short, readable diff of what did not add up, for an error message. */
export function describeMismatches(
  report: ReconciliationReport,
  limit = 5,
): string {
  if (report.status !== "mismatch") return "";
  const lines = report.mismatches
    .slice(0, limit)
    .map((m) =>
      Number.isNaN(m.printedBalance)
        ? `  line ${m.lineNumber}: ${m.hint}`
        : `  line ${m.lineNumber}: previous balance ${m.previousBalance} + amount ${m.amount} = ${m.expectedBalance}, but the statement prints ${m.printedBalance} (off by ${m.difference}) — ${m.hint}`,
    );
  if (report.mismatches.length > limit)
    lines.push(`  …and ${report.mismatches.length - limit} more`);
  if (report.totalMatches === false && report.openingBalance !== null) {
    lines.push(
      `  whole statement: opening ${report.openingBalance} + parsed total ${report.total} = ${report.openingBalance + report.total}, but it closes at ${report.closingBalance}`,
    );
  }
  return lines.join("\n");
}
