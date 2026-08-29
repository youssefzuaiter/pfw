import "server-only";
import type { Currency, Prisma } from "../../generated/prisma/client";
import { withUserScope } from "../db/with-user-scope";

/** See bank-accounts.ts for why this returns `null` rather than throwing on a mismatch. */
export async function getTransactionById(userId: string, id: string) {
  return withUserScope(userId, (tx) =>
    tx.notableTransaction.findFirst({
      where: { id, userId },
      include: { category: true, bankAccount: true },
    }),
  );
}

export type TransactionSort = "date_desc" | "date_asc" | "amount_desc" | "amount_asc";

const ORDER_BY: Record<TransactionSort, Prisma.NotableTransactionOrderByWithRelationInput> = {
  date_desc: { occurredAt: "desc" },
  date_asc: { occurredAt: "asc" },
  amount_desc: { amount: "desc" },
  amount_asc: { amount: "asc" },
};

export type TransactionFilters = {
  categoryId?: string;
  search?: string;
  dateFrom?: Date;
  dateTo?: Date;
  sort?: TransactionSort;
};

/**
 * `description` is encrypted at rest (schema.prisma) — a database-level
 * `contains` filter on it would search ciphertext and silently never
 * match anything. `categoryId` and the date range ARE plaintext columns
 * and are filtered at the database level; `search` is applied in
 * application code, after decryption, against both `description` and
 * the (plaintext) `merchantName`. Fine at this app's scale (a personal
 * ledger, not millions of rows) — correctness matters here, not query-
 * plan optimality.
 */
export async function listTransactions(userId: string, filters: TransactionFilters = {}) {
  const where: Prisma.NotableTransactionWhereInput = { userId };
  if (filters.categoryId) where.categoryId = filters.categoryId;
  if (filters.dateFrom || filters.dateTo) {
    where.occurredAt = {
      ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
      ...(filters.dateTo ? { lte: filters.dateTo } : {}),
    };
  }

  const rows = await withUserScope(userId, (tx) =>
    tx.notableTransaction.findMany({
      where,
      orderBy: ORDER_BY[filters.sort ?? "date_desc"],
      include: { category: true, bankAccount: true },
    }),
  );

  if (!filters.search) return rows;

  const term = filters.search.toLowerCase();
  return rows.filter(
    (row) => row.description.toLowerCase().includes(term) || (row.merchantName?.toLowerCase().includes(term) ?? false),
  );
}

export type UpdateTransactionCategoryResult = Awaited<ReturnType<typeof getTransactionById>>;

/**
 * The /transactions screen's "inline recategorisation" mutation. Clears
 * `needsReview` — a human just confirmed a category, so the review queue
 * shouldn't keep flagging it. Returns `null` on an ownership mismatch,
 * same convention as every other DAL getter (never throws to signal
 * "not yours").
 */
export async function updateTransactionCategory(
  userId: string,
  id: string,
  categoryId: string,
): Promise<UpdateTransactionCategoryResult> {
  return withUserScope(userId, async (tx) => {
    const existing = await tx.notableTransaction.findFirst({ where: { id, userId } });
    if (!existing) return null;

    const category = await tx.category.findFirst({ where: { id: categoryId, userId } });
    if (!category) return null;

    return tx.notableTransaction.update({
      where: { id },
      data: { categoryId, needsReview: false },
      include: { category: true, bankAccount: true },
    });
  });
}

export async function countNeedsReview(userId: string): Promise<number> {
  return withUserScope(userId, (tx) => tx.notableTransaction.count({ where: { userId, needsReview: true } }));
}

export type CategorySpend = {
  categoryId: string;
  totalAgorot: bigint;
};

/** Sum of transaction amounts per category within [from, to) — used for budget utilization and the category-spend donut. Only negative (expense) amounts are summed, as a positive magnitude. */
export async function getSpendByCategoryInRange(userId: string, from: Date, to: Date): Promise<CategorySpend[]> {
  return withUserScope(userId, async (tx) => {
    const grouped = await tx.notableTransaction.groupBy({
      by: ["categoryId"],
      where: { userId, occurredAt: { gte: from, lt: to }, amount: { lt: 0n } },
      _sum: { amount: true },
    });
    return grouped.map((g) => ({
      categoryId: g.categoryId,
      totalAgorot: -(g._sum.amount ?? 0n),
    }));
  });
}

export type MonthlyIncomeExpense = {
  monthKey: string;
  incomeAgorot: bigint;
  expenseAgorot: bigint;
};

/** Buckets every transaction in [from, to) by calendar month, summing income (positive) and expense (negative, reported as a positive magnitude) separately. */
export async function getMonthlyIncomeExpenseHistory(
  userId: string,
  from: Date,
  to: Date,
): Promise<MonthlyIncomeExpense[]> {
  const rows = await withUserScope(userId, (tx) =>
    tx.notableTransaction.findMany({
      where: { userId, occurredAt: { gte: from, lt: to } },
      select: { occurredAt: true, amount: true },
    }),
  );

  const byMonth = new Map<string, { income: bigint; expense: bigint }>();
  for (const row of rows) {
    const monthKey = row.occurredAt.toISOString().slice(0, 7);
    const bucket = byMonth.get(monthKey) ?? { income: 0n, expense: 0n };
    if (row.amount > 0n) {
      bucket.income += row.amount;
    } else {
      bucket.expense += -row.amount;
    }
    byMonth.set(monthKey, bucket);
  }

  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([monthKey, { income, expense }]) => ({ monthKey, incomeAgorot: income, expenseAgorot: expense }));
}

export type MerchantOccurrenceRow = {
  merchantKey: string;
  /** The original-cased merchant/description string, for display — merchantKey is normalized (trimmed, lowercased) and isn't fit to show a user. */
  displayName: string;
  amount: bigint;
  occurredAt: Date;
  /** Added for the subscription radar (AGENTS.md §3p) — a foreign-currency recurring
   * charge's *native* amount stays constant even when its ILS `amount` drifts with the
   * exchange rate, which is what lets price-hike detection tell a real price change
   * apart from ordinary FX noise. Purely additive to this row shape; existing callers
   * (recurring-detection.ts via build-dashboard-data.ts) only ever read `amount`. */
  currency: Currency;
  nativeAmount: bigint;
};

/**
 * Raw rows for the recurring-detection engine (src/lib/recurring-detection.ts)
 * and the subscription radar (src/lib/subscription-radar.ts). Includes both
 * income and expenses — a recurring salary deposit is just as real a
 * periodicity signal as a recurring subscription charge, and the
 * cash-flow forecast needs projected future income, not only projected
 * future bills. Callers that only want spend should filter to negative
 * amounts themselves (see build-dashboard-data.ts).
 */
export async function getTransactionOccurrencesSince(userId: string, since: Date): Promise<MerchantOccurrenceRow[]> {
  const rows = await withUserScope(userId, (tx) =>
    tx.notableTransaction.findMany({
      where: { userId, occurredAt: { gte: since } },
      select: { merchantName: true, description: true, amount: true, occurredAt: true, currency: true, nativeAmount: true },
    }),
  );

  return rows.map((row) => {
    const displayName = (row.merchantName ?? row.description).trim();
    return {
      merchantKey: displayName.toLowerCase(),
      displayName,
      amount: row.amount,
      occurredAt: row.occurredAt,
      currency: row.currency,
      nativeAmount: row.nativeAmount,
    };
  });
}
