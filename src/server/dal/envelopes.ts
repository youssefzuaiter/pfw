import { categoryParts } from "../../lib/transaction-splits";
import { REAL_MONEY, SPLIT_PARTS_SELECT } from "./transactions";
import "server-only";
import { currentBalanceAgorot } from "../../lib/account-balance";
import { monthKeyToExclusiveEndDate } from "../../lib/date-month";
import {
  computeAvailableToBudget,
  computeRollingBalance,
  sumEnvelopeReserve,
  type MonthlyEnvelopeActivity,
} from "../../lib/envelope-math";
import { agorot, type Agorot } from "../../lib/money";
import { settleAccounts } from "../../lib/safe-to-spend";
import { withUserScope, type ScopedTransactionClient } from "../db/with-user-scope";
import { loadAccountBalanceParts } from "./account-balances";
import { getLatestRateTable, type RateTable } from "./exchange-rates";

/**
 * Zero-Sum Envelope Budgeting — the ledger-math DAL. Every function
 * fetches already-aggregated rows and hands them to the pure functions
 * in `src/lib/envelope-math.ts` for the actual rolling-balance math,
 * same "DAL fetches, lib computes" split this app's other engines
 * already follow (AGENTS.md §3b) — no `envelope-math.ts` import here is
 * from `src/server/dal/transactions.ts`, and nothing here imports FROM
 * this module either: every query below runs directly against the
 * already-open `tx` client inside `withUserScope`, the same way
 * `transaction-import.ts`/`transactions.ts` themselves query
 * `tx.category`/`tx.bankAccount` directly rather than importing
 * `categories.ts`/`bank-accounts.ts` — so there is no
 * transactions-DAL <-> envelopes-DAL circular dependency to hit.
 */

export type EnvelopeBalance = {
  categoryId: string;
  categoryName: string;
  /** Rolling balance as of `month`: every allocation minus every expense, up to and including `month`. */
  balanceAgorot: Agorot;
  /** This one month's own allocation (not cumulative) — what an "allocate" input should show as its current value. */
  allocatedThisMonthAgorot: Agorot;
  /** This one month's own expense total (not cumulative), as a positive magnitude. */
  spentThisMonthAgorot: Agorot;
  /** This category's current household-sharing state (AGENTS.md §3s) — the most recent allocation row's `sharedGroupId`, or `null` if never allocated to or never shared. Drives `<ShareResourceControl>`'s current selection. */
  sharedGroupId: string | null;
};

export type BudgetPosition = {
  /** Cash in the accounts that count (checking, and savings unless turned off). */
  cashAgorot: Agorot;
  /** What credit cards owe; an overpaid card owes nothing. */
  cardOwedAgorot: Agorot;
  /** The positive envelope balances: money already set aside. */
  envelopeReserveAgorot: Agorot;
  /** Cash that has not been given a job yet; negative when more is set aside than the cash covers. */
  availableAgorot: Agorot;
  /** Savings left out of cash by the user's setting, so the page can say so. */
  savingsLeftOutAgorot: Agorot;
};

/**
 * "Available to budget" (AGENTS.md §3rrrr): cash in the accounts, minus what
 * the cards owe, minus what already sits in envelopes. The first three lines
 * of Safe to Spend, built from the same balances, so the two reconcile; Safe
 * to Spend then also holds back bills, debts and goals still to come.
 *
 * The zero-sum rule refuses to set aside more than this, so an envelope can
 * never be funded with money that is not there. (It used to be all income ever
 * received minus all allocations, which ignored everything spent outside an
 * envelope.)
 *
 * `rateTable` is passed in because it is read outside a user-scoped
 * transaction; fetch it before opening the one this runs in.
 */
export async function budgetPositionInTransaction(
  tx: ScopedTransactionClient,
  userId: string,
  month: string,
  rateTable: RateTable,
): Promise<BudgetPosition> {
  const [accountRows, balances, settings] = await Promise.all([
    loadAccountBalanceParts(tx, userId),
    envelopeBalancesInTransaction(tx, userId, month),
    tx.userSettings.findUnique({ where: { userId }, select: { safeToSpendCountSavings: true } }),
  ]);
  const countSavings = settings?.safeToSpendCountSavings ?? true;

  const { cashAgorot, cardOwedAgorot, savingsAgorot, savingsCounted } = settleAccounts(
    accountRows.map(({ parts }) => ({
      accountType: parts.accountType,
      balanceAgorot: currentBalanceAgorot(parts, rateTable[parts.currency]),
    })),
    { countSavings },
  );
  const envelopeReserveAgorot = sumEnvelopeReserve(balances.map((b) => b.balanceAgorot));

  return {
    cashAgorot,
    cardOwedAgorot,
    envelopeReserveAgorot,
    availableAgorot: computeAvailableToBudget({ cashAgorot, cardOwedAgorot, envelopeReserveAgorot }),
    savingsLeftOutAgorot: savingsCounted ? agorot(0) : savingsAgorot,
  };
}

/** `budgetPositionInTransaction` in a transaction of its own. */
export async function getBudgetPosition(userId: string, month: string): Promise<BudgetPosition> {
  const rateTable = await getLatestRateTable();
  return withUserScope(userId, (tx) => budgetPositionInTransaction(tx, userId, month, rateTable));
}

/** Just the available figure. */
export async function getAvailableToBudget(userId: string, month: string): Promise<Agorot> {
  return (await getBudgetPosition(userId, month)).availableAgorot;
}

/**
 * Every active category's envelope, as of `month`: the rolling balance
 * (carry-forward/overspend both fall out of `computeRollingBalance`'s
 * single cumulative sum, AGENTS.md-style "derived truth" — nothing here
 * is a stored running total), plus this month's own allocation/spend for
 * the UI's "current month" columns. Includes every active, non-
 * -Uncategorized category, even ones never allocated to — same "show
 * every category, not just budgeted ones" convention the old `/budgets`
 * page's "unbudgeted categories" section already established.
 */
export async function getEnvelopeBalances(userId: string, month: string): Promise<EnvelopeBalance[]> {
  return withUserScope(userId, (tx) => envelopeBalancesInTransaction(tx, userId, month));
}

/** `getEnvelopeBalances` inside a transaction the caller already holds. */
export async function envelopeBalancesInTransaction(
  tx: ScopedTransactionClient,
  userId: string,
  month: string,
): Promise<EnvelopeBalance[]> {
  {
    const cutoff = monthKeyToExclusiveEndDate(month);

    const [categories, allocationRows, transactionRows] = await Promise.all([
      tx.category.findMany({ where: { userId, archivedAt: null, isUncategorized: false } }),
      tx.envelopeAllocation.findMany({
        where: { userId, month: { lte: month } },
        select: { categoryId: true, month: true, amountAgorot: true, sharedGroupId: true },
      }),
      tx.notableTransaction.findMany({
        where: { userId, occurredAt: { lt: cutoff }, amount: { lt: 0n }, ...REAL_MONEY },
        select: { categoryId: true, occurredAt: true, amount: true, nativeAmount: true, splits: SPLIT_PARTS_SELECT },
      }),
    ]);

    // Bucket every allocation/expense row by (categoryId, month) — the
    // shape computeRollingBalance's MonthlyEnvelopeActivity[] input
    // expects, same "fetch raw rows, bucket by month in application
    // code" pattern getMonthlyIncomeExpenseHistory (transactions.ts)
    // already uses for an analogous cumulative-by-month figure.
    const activityByCategory = new Map<string, Map<string, { allocated: number; spent: number }>>();
    function bucket(categoryId: string, monthKey: string) {
      const byMonth = activityByCategory.get(categoryId) ?? new Map<string, { allocated: number; spent: number }>();
      activityByCategory.set(categoryId, byMonth);
      const entry = byMonth.get(monthKey) ?? { allocated: 0, spent: 0 };
      byMonth.set(monthKey, entry);
      return entry;
    }

    // Tracks the sharedGroupId of each category's MOST RECENT allocation
    // row seen so far (rows aren't guaranteed to arrive in month order).
    const latestSharedGroupState = new Map<string, { month: string; sharedGroupId: string | null }>();
    for (const row of allocationRows) {
      bucket(row.categoryId, row.month).allocated += Number(row.amountAgorot);

      const current = latestSharedGroupState.get(row.categoryId);
      if (!current || row.month > current.month) {
        latestSharedGroupState.set(row.categoryId, { month: row.month, sharedGroupId: row.sharedGroupId });
      }
    }
    for (const row of transactionRows) {
      const monthKey = row.occurredAt.toISOString().slice(0, 7);
      // A split row spends from each of its envelopes (AGENTS.md §3xxx).
      for (const part of categoryParts(row)) bucket(part.categoryId, monthKey).spent += Number(-part.amount);
    }

    return categories.map((category) => {
      const byMonth = activityByCategory.get(category.id) ?? new Map();
      const activity: MonthlyEnvelopeActivity[] = [...byMonth.entries()].map(([monthKey, entry]) => ({
        month: monthKey,
        allocatedAgorot: agorot(entry.allocated),
        spentAgorot: agorot(entry.spent),
      }));

      const thisMonth = byMonth.get(month) ?? { allocated: 0, spent: 0 };

      return {
        categoryId: category.id,
        categoryName: category.name,
        balanceAgorot: computeRollingBalance(activity, month),
        allocatedThisMonthAgorot: agorot(thisMonth.allocated),
        spentThisMonthAgorot: agorot(thisMonth.spent),
        sharedGroupId: latestSharedGroupState.get(category.id)?.sharedGroupId ?? null,
      };
    });
  }
}

export type AllocateToEnvelopeResult =
  | { ok: true; categoryId: string; month: string; amountAgorot: Agorot }
  | { ok: false; error: "category_not_found" };

/**
 * Sets (not increments) this category's allocation for `month` — a
 * create-or-update on the `@@unique([userId, categoryId, month])`
 * constraint. Zero-sum validation (does this exceed `getAvailableToBudget`)
 * is the API route's job (Phase 3), not this function's — this is a
 * plain, unvalidated write, same division of responsibility
 * `upsertBudget` used to have.
 *
 * A NEW row (this category has never been allocated to before, in any
 * month) inherits `sharedGroupId` from the category's most recent PRIOR
 * allocation, if one exists and is shared — see schema.prisma's
 * `EnvelopeAllocation` doc comment for why this is what makes sharing a
 * durable, category-level decision rather than something re-applied
 * every month. Updating an EXISTING month's row never touches its
 * sharing state.
 */
export async function allocateToEnvelope(
  userId: string,
  categoryId: string,
  amountAgorot: Agorot,
  month: string,
): Promise<AllocateToEnvelopeResult> {
  return withUserScope(userId, (tx) => allocateInTransaction(tx, userId, categoryId, amountAgorot, month));
}

/** `allocateToEnvelope` inside a transaction the caller already holds. */
export async function allocateInTransaction(
  tx: ScopedTransactionClient,
  userId: string,
  categoryId: string,
  amountAgorot: Agorot,
  month: string,
): Promise<AllocateToEnvelopeResult> {
  const category = await tx.category.findFirst({ where: { id: categoryId, userId } });
  if (!category) return { ok: false, error: "category_not_found" };

  const existing = await tx.envelopeAllocation.findUnique({
    where: { userId_categoryId_month: { userId, categoryId, month } },
  });

  if (existing) {
    const updated = await tx.envelopeAllocation.update({
      where: { id: existing.id },
      data: { amountAgorot: BigInt(amountAgorot) },
    });
    return { ok: true, categoryId, month, amountAgorot: agorot(Number(updated.amountAgorot)) };
  }

  const priorAllocation = await tx.envelopeAllocation.findFirst({
    where: { userId, categoryId, month: { lt: month } },
    orderBy: { month: "desc" },
    select: { sharedGroupId: true },
  });

  const created = await tx.envelopeAllocation.create({
    data: {
      userId,
      categoryId,
      month,
      amountAgorot: BigInt(amountAgorot),
      sharedGroupId: priorAllocation?.sharedGroupId ?? null,
    },
  });
  return { ok: true, categoryId, month, amountAgorot: agorot(Number(created.amountAgorot)) };
}
