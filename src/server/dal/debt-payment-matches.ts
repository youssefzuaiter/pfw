import { matchDebtPayments, type DebtPaymentMatch } from "../../lib/debt-payment-matching";
import { withUserScope } from "../db/with-user-scope";
import type { ScopedTransactionClient } from "../db/with-user-scope";
import { recordDebtPaymentInTransaction } from "./debts";
import { REAL_MONEY } from "./transactions";

/** The most rows looked at in one pass, newest first. */
const MAX_ROWS = 20_000;

/** The most payments one apply may record. */
export const MAX_DEBT_PAYMENTS_PER_APPLY = 100;

export type DebtPaymentMatchView = DebtPaymentMatch & {
  debtName: string;
  /** A payment already recorded from this transaction. */
  recorded: boolean;
};

export type DebtPaymentMatchOptions = {
  /**
   * Count a repayment made before the debt was added. A debt's balance already
   * holds those, so they are never recorded, but "what was paid this month"
   * (Safe to Spend) is about cash and does count them. Needs `from`.
   */
  includeBeforeDebtAdded?: boolean;
  /** Only repayments on or after this day. */
  from?: Date;
};

async function loadMatches(tx: ScopedTransactionClient, userId: string, options: DebtPaymentMatchOptions = {}): Promise<DebtPaymentMatchView[]> {
  const found = await tx.debt.findMany({ where: { userId }, select: { id: true, name: true, createdAt: true } });
  if (found.length === 0) return [];
  const debts = options.includeBeforeDebtAdded ? found.map((debt) => ({ ...debt, createdAt: new Date(0) })) : found;

  const oldestDebt = debts.reduce((oldest, debt) => (debt.createdAt < oldest ? debt.createdAt : oldest), debts[0].createdAt);
  const since = options.from && options.from > oldestDebt ? options.from : oldestDebt;
  const rows = await tx.notableTransaction.findMany({
    // Live, not a transfer, money out, after the oldest debt was added.
    where: { userId, ...REAL_MONEY, amount: { lt: 0n }, occurredAt: { gte: new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate())) } },
    orderBy: { occurredAt: "desc" },
    take: MAX_ROWS,
    select: { id: true, occurredAt: true, amount: true, merchantName: true, description: true },
  });
  const matches = matchDebtPayments(
    debts,
    rows.map((row) => ({ id: row.id, occurredAt: row.occurredAt, amountAgorot: Number(row.amount), label: (row.merchantName ?? row.description).trim() })),
  );
  if (matches.length === 0) return [];

  const recordedIds = new Set(
    (await tx.debtPayment.findMany({ where: { userId, transactionId: { in: matches.map((m) => m.transactionId) } }, select: { transactionId: true } })).map((p) => p.transactionId),
  );
  const names = new Map(debts.map((debt) => [debt.id, debt.name]));
  return matches.map((match) => ({ ...match, debtName: names.get(match.debtId) ?? "", recorded: recordedIds.has(match.transactionId) }));
}

/**
 * The repayments of the user's debts that are already in the ledger (AGENTS.md
 * §3nnnn), recorded or not. Writes nothing.
 */
export async function listDebtPaymentMatches(userId: string, options: DebtPaymentMatchOptions = {}): Promise<DebtPaymentMatchView[]> {
  return withUserScope(userId, (tx) => loadMatches(tx, userId, options));
}

export type ApplyDebtPaymentMatchesResult = {
  applied: number;
  /** Requested items that are no longer a match, or were already recorded. */
  skipped: number;
};

/**
 * Records the requested transactions as payments of their debts, oldest first
 * so each reduces the balance the next starts from, all or nothing. The request
 * is untrusted: matching is run again here and an item is applied only if it is
 * still exactly what the matcher proposes and has not been recorded; anything
 * else, including another user's ids, is skipped.
 */
export async function applyDebtPaymentMatches(
  userId: string,
  items: readonly { debtId: string; transactionId: string }[],
): Promise<ApplyDebtPaymentMatchesResult> {
  if (items.length === 0 || items.length > MAX_DEBT_PAYMENTS_PER_APPLY) {
    throw new RangeError(`Apply takes between 1 and ${MAX_DEBT_PAYMENTS_PER_APPLY} payments`);
  }

  return withUserScope(
    userId,
    async (tx) => {
      const open = new Map<string, DebtPaymentMatchView>();
      for (const m of await loadMatches(tx, userId)) if (!m.recorded) open.set(`${m.debtId}|${m.transactionId}`, m);
      const wanted: DebtPaymentMatchView[] = [];
      const seen = new Set<string>();
      let skipped = 0;
      for (const item of items) {
        const key = `${item.debtId}|${item.transactionId}`;
        const match = open.get(key);
        if (!match || seen.has(key)) {
          skipped++;
          continue;
        }
        seen.add(key);
        wanted.push(match);
      }

      wanted.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.transactionId.localeCompare(b.transactionId));
      for (const match of wanted) {
        await recordDebtPaymentInTransaction(tx, userId, match.debtId, {
          amount: BigInt(match.amountAgorot),
          paidAt: match.occurredAt,
          transactionId: match.transactionId,
        });
      }
      return { applied: wanted.length, skipped };
    },
    { timeoutMs: 60_000 },
  );
}
