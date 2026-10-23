import { namesMatch } from "./recurring-bills";

/**
 * Finds the repayments of a debt that are already in the ledger (AGENTS.md
 * §3nnnn): a transaction whose name matches the debt's, made after the debt
 * was added. Pure: the caller supplies the debts and the rows.
 *
 * Only a row that matches exactly ONE debt is a match. A row that fits two
 * debts is skipped rather than guessed, because recording it would reduce the
 * wrong balance. A debt's balance is what the user entered when they added it,
 * so a payment dated before that is already in it, and is never a match.
 */

export type DebtRef = { id: string; name: string; createdAt: Date };

export type LedgerRow = {
  id: string;
  occurredAt: Date;
  /** Signed ILS agorot: negative is money out. */
  amountAgorot: number;
  /** The merchant, or the description when there is none. */
  label: string;
};

export type DebtPaymentMatch = {
  debtId: string;
  transactionId: string;
  occurredAt: Date;
  /** Positive ILS agorot. */
  amountAgorot: number;
  label: string;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const utcDay = (date: Date): number => Math.floor(date.getTime() / MS_PER_DAY);

export function matchDebtPayments(debts: readonly DebtRef[], rows: readonly LedgerRow[]): DebtPaymentMatch[] {
  const matches: DebtPaymentMatch[] = [];
  for (const row of rows) {
    if (row.amountAgorot >= 0 || !row.label.trim()) continue;
    const candidates = debts.filter((debt) => utcDay(row.occurredAt) >= utcDay(debt.createdAt) && namesMatch(debt.name, row.label));
    if (candidates.length !== 1) continue;
    matches.push({
      debtId: candidates[0].id,
      transactionId: row.id,
      occurredAt: row.occurredAt,
      amountAgorot: -row.amountAgorot,
      label: row.label,
    });
  }
  return matches.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.transactionId.localeCompare(b.transactionId));
}

/** What a debt has been paid in the ledger inside [`from`, `to`): the matched rows' amounts added up, per debt. */
export function matchedPaidInPeriod(matches: readonly DebtPaymentMatch[], from: Date, to: Date): Map<string, number> {
  const paid = new Map<string, number>();
  for (const match of matches) {
    if (match.occurredAt < from || match.occurredAt >= to) continue;
    paid.set(match.debtId, (paid.get(match.debtId) ?? 0) + match.amountAgorot);
  }
  return paid;
}
