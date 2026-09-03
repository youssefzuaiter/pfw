import "server-only";
import { monthKeyToExclusiveEndDate } from "../../lib/date-month";
import { computeAvailableToBudget, computeRollingBalance, type MonthlyEnvelopeActivity } from "../../lib/envelope-math";
import { agorot, type Agorot } from "../../lib/money";
import { withUserScope } from "../db/with-user-scope";

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

/**
 * "Ready to assign": real income received up to and including `month`,
 * minus every allocation made up to and including `month`, across every
 * category. Phase 3's allocate route rejects a new allocation that would
 * push total allocations past this figure.
 */
export async function getAvailableToBudget(userId: string, month: string): Promise<Agorot> {
  return withUserScope(userId, async (tx) => {
    const cutoff = monthKeyToExclusiveEndDate(month);

    const [incomeResult, allocationResult] = await Promise.all([
      tx.notableTransaction.aggregate({
        where: { userId, occurredAt: { lt: cutoff }, amount: { gt: 0n } },
        _sum: { amount: true },
      }),
      tx.envelopeAllocation.aggregate({
        where: { userId, month: { lte: month } },
        _sum: { amountAgorot: true },
      }),
    ]);

    const totalIncome = agorot(Number(incomeResult._sum.amount ?? 0n));
    const totalAllocated = agorot(Number(allocationResult._sum.amountAgorot ?? 0n));
    return computeAvailableToBudget(totalIncome, totalAllocated);
  });
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
  return withUserScope(userId, async (tx) => {
    const cutoff = monthKeyToExclusiveEndDate(month);

    const [categories, allocationRows, transactionRows] = await Promise.all([
      tx.category.findMany({ where: { userId, archivedAt: null, isUncategorized: false } }),
      tx.envelopeAllocation.findMany({
        where: { userId, month: { lte: month } },
        select: { categoryId: true, month: true, amountAgorot: true, sharedGroupId: true },
      }),
      tx.notableTransaction.findMany({
        where: { userId, occurredAt: { lt: cutoff }, amount: { lt: 0n } },
        select: { categoryId: true, occurredAt: true, amount: true },
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
      bucket(row.categoryId, monthKey).spent += Number(-row.amount);
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
  });
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
  return withUserScope(userId, async (tx) => {
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
  });
}
