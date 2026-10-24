/**
 * Compares the balance the app works out for an account with the balance the
 * bank shows, and points at the likely reason for any gap (AGENTS.md §3oooo).
 * Pure: the caller supplies the account's figures and the movement since the
 * balance the user entered.
 *
 * A balance here is in minor units of the account's own currency. For a card it
 * is money OWED, so a charge raises it; `deltaNative` on each row is already the
 * effect of that row on the balance the app shows (a charge on a card is
 * positive, a payment negative; a deposit into a checking account is positive).
 *
 * The causes are suggestions, ranked, never certain: the same gap can be a
 * missing transaction, a duplicate or a wrong starting figure, and the data
 * cannot tell which.
 */

export type MovementRow = {
  id: string;
  /** `YYYY-MM-DD`. */
  day: string;
  label: string;
  /** The effect of this row on the balance the app shows, minor units. */
  deltaNative: number;
};

export type BalanceCheckInput = {
  /** The balance the user entered, minor units. */
  typedNative: number;
  /** The movement since it, up to and including the day being checked. */
  rows: readonly MovementRow[];
  /** The bank's figure for the day being checked, minor units. */
  bankNative: number;
};

export type Cause =
  /** This row, removed, would close the gap, and another row looks like its twin. */
  | { kind: "duplicate"; rowId: string; twinId: string }
  /** This row, removed, would close the gap. */
  | { kind: "extra-row"; rowId: string }
  /** This row with its sign flipped would close the gap. */
  | { kind: "wrong-sign"; rowId: string }
  /** Nothing in the data explains it: a transaction missing, or the entered balance off, by exactly the gap. */
  | { kind: "missing-or-start" };

export type BalanceCheckResult = {
  /** What the app says the balance is, minor units. */
  expectedNative: number;
  bankNative: number;
  /** bank minus app: positive means the bank shows more (for a card: more owed). */
  gapNative: number;
  status: "matches" | "bank-higher" | "bank-lower";
  causes: Cause[];
};

/** Two rows are twins when they are this many days apart or less. */
export const TWIN_DAY_WINDOW = 3;

/** The most causes returned: the best few, not every coincidence. */
const MAX_CAUSES = 4;

const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);

export function checkBalance(input: BalanceCheckInput): BalanceCheckResult {
  const flow = input.rows.reduce((sum, row) => sum + row.deltaNative, 0);
  const expectedNative = input.typedNative + flow;
  const gapNative = input.bankNative - expectedNative;
  const status = gapNative === 0 ? "matches" : gapNative > 0 ? "bank-higher" : "bank-lower";
  if (gapNative === 0) return { expectedNative, bankNative: input.bankNative, gapNative, status, causes: [] };

  const causes: Cause[] = [];

  // A row whose own effect is the gap: the app has counted it and the bank has not.
  // The app's figure is too high by the gap's size when the gap is negative.
  const extras = input.rows.filter((row) => row.deltaNative === -gapNative);
  const withTwin: Cause[] = [];
  const withoutTwin: Cause[] = [];
  for (const row of extras) {
    const twin = input.rows.find(
      (other) => other.id !== row.id && other.deltaNative === row.deltaNative && Math.abs(dayNumber(other.day) - dayNumber(row.day)) <= TWIN_DAY_WINDOW,
    );
    if (twin) withTwin.push({ kind: "duplicate", rowId: row.id, twinId: twin.id });
    else withoutTwin.push({ kind: "extra-row", rowId: row.id });
  }
  causes.push(...withTwin, ...withoutTwin);

  // A row with the wrong sign is out by twice its size.
  for (const row of input.rows) {
    if (row.deltaNative !== 0 && 2 * row.deltaNative === -gapNative) {
      causes.push({ kind: "wrong-sign", rowId: row.id });
    }
  }

  causes.push({ kind: "missing-or-start" });

  // Several identical rows would each be a candidate: one per twin pair is enough.
  const seen = new Set<string>();
  const unique = causes.filter((cause) => {
    const key = cause.kind === "duplicate" ? `dup:${[cause.rowId, cause.twinId].sort().join("|")}` : `${cause.kind}:${"rowId" in cause ? cause.rowId : ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { expectedNative, bankNative: input.bankNative, gapNative, status, causes: unique.slice(0, MAX_CAUSES) };
}
