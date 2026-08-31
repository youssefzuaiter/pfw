import "server-only";
import { Prisma } from "../../generated/prisma/client";
import type { Currency } from "../../generated/prisma/client";
import { categorizeTransaction } from "../../lib/categorization/cascade";
import type { PastOccurrence } from "../../lib/categorization/types";
import { neutralizeFormulaInjection } from "../../lib/csv-import/formula-injection";
import { CURRENT_EMBEDDING_MODEL_ID } from "../../lib/embeddings/embedding-model";
import { normalizeMerchantKey } from "../../lib/text-matching";
import { toPgVectorLiteral } from "../../lib/vector-math";
import { withUserScope, type ScopedTransactionClient } from "../db/with-user-scope";
import { BankAccountNotFoundError } from "./transaction-import";

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

/** Writes this transaction's semantic search index (AGENTS.md §3cc) — not a correctness dependency of the caller's real mutation, so a failure here is never allowed to fail the caller's category assignment. */
async function setSearchEmbedding(
  tx: ScopedTransactionClient,
  transactionId: string,
  embedding: readonly number[],
): Promise<void> {
  const vectorLiteral = toPgVectorLiteral(embedding);
  await tx.$executeRaw`UPDATE "NotableTransaction" SET "searchEmbedding" = ${vectorLiteral}::vector WHERE "id" = ${transactionId}`;
}

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

export type SemanticSearchFilters = {
  categoryId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  limit?: number;
};

const DEFAULT_SEARCH_LIMIT = 50;
/** Cosine DISTANCE ceiling (pgvector's `<=>` operator returns `1 - cosine similarity`) — 0.25 mirrors tier3-knn.ts's own DEFAULT_MIN_SIMILARITY = 0.75 floor, so both of this app's KNN-shaped features agree on what "actually similar" means. */
const MAX_COSINE_DISTANCE = 0.25;

/**
 * Replaces the plain substring `search` filter above for any caller that
 * can supply a client-computed query embedding (AGENTS.md §3cc) — ranks
 * by real semantic similarity via pgvector's `<=>` cosine-distance
 * operator, computed by Postgres itself, not application code. Only
 * ever searches transactions that HAVE a stored `searchEmbedding` —
 * every pre-existing row and anything imported without one stays
 * unreachable by this function specifically (not an oversight: see the
 * schema's own model comment on `searchEmbedding` for why this is a
 * forward-only index, same accepted limitation MerchantEmbedding's own
 * corrections table already has). Callers that need to search
 * transactions with no embedding at all should fall back to
 * `listTransactions`'s `search` filter — the two are deliberately
 * separate functions, not merged into one with a mode flag, so each
 * stays simple to read on its own.
 */
export async function searchTransactionsSemantic(
  userId: string,
  queryEmbedding: readonly number[],
  filters: SemanticSearchFilters = {},
) {
  const vectorLiteral = toPgVectorLiteral(queryEmbedding);
  const limit = filters.limit ?? DEFAULT_SEARCH_LIMIT;

  return withUserScope(userId, async (tx) => {
    const conditions = [
      Prisma.sql`"userId" = ${userId}`,
      Prisma.sql`"searchEmbedding" IS NOT NULL`,
      Prisma.sql`"searchEmbedding" <=> ${vectorLiteral}::vector <= ${MAX_COSINE_DISTANCE}`,
    ];
    if (filters.categoryId) conditions.push(Prisma.sql`"categoryId" = ${filters.categoryId}`);
    if (filters.dateFrom) conditions.push(Prisma.sql`"occurredAt" >= ${filters.dateFrom}`);
    if (filters.dateTo) conditions.push(Prisma.sql`"occurredAt" <= ${filters.dateTo}`);

    // Raw SQL here computes ranking and returns bare ids ONLY — never a
    // full row. $queryRaw bypasses every Prisma Client extension,
    // including src/server/db/encrypted-fields.ts's transparent
    // `description` decryption (extensions wrap the normal
    // query-builder methods, not $queryRaw) — fetching a full row this
    // way would silently hand back raw AES-256-GCM ciphertext instead
    // of plaintext. The real rows are fetched below through the
    // ordinary, extension-wrapped `tx.notableTransaction.findMany`.
    const ranked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "NotableTransaction"
      WHERE ${Prisma.join(conditions, " AND ")}
      ORDER BY "searchEmbedding" <=> ${vectorLiteral}::vector ASC
      LIMIT ${limit}
    `;

    if (ranked.length === 0) return [];

    const rows = await tx.notableTransaction.findMany({
      where: { id: { in: ranked.map((r) => r.id) }, userId },
      include: { category: true, bankAccount: true },
    });

    // findMany's `id: { in: [...] }` does NOT preserve the IN-list's
    // order — Postgres/Prisma return matching rows in their own order,
    // not the similarity ranking `ranked` already established. This
    // re-sort is what actually makes "most similar first" true for the
    // caller, not just true of the intermediate raw-SQL result.
    const rowById = new Map(rows.map((row) => [row.id, row]));
    return ranked.map((r) => rowById.get(r.id)).filter((row): row is (typeof rows)[number] => row !== undefined);
  });
}

export type UpdateTransactionCategoryResult = Awaited<ReturnType<typeof getTransactionById>>;

/**
 * The /transactions screen's "inline recategorisation" mutation. Clears
 * `needsReview` — a human just confirmed a category, so the review queue
 * shouldn't keep flagging it. Returns `null` on an ownership mismatch,
 * same convention as every other DAL getter (never throws to signal
 * "not yours").
 *
 * The Self-Learning Vector Categorization Engine's feedback loop
 * (AGENTS.md §3u): when `embedding` is supplied (computed client-side by
 * src/lib/embeddings/local-embedder.ts, for exactly this transaction's
 * merchant text), this manual correction upserts the merchant's
 * reference vector in the SAME transaction as the category update —
 * atomicity matters here specifically because these two writes are the
 * whole point of "feedback loop": a category change that silently failed
 * to also update the vector it should teach would leave Tier 3 KNN
 * stuck learning from a stale correction. `embedding` is optional
 * (older/non-JS clients, or a browser where the local model failed to
 * load) — the category update itself never depends on it.
 */
export async function updateTransactionCategory(
  userId: string,
  id: string,
  categoryId: string,
  embedding?: readonly number[],
): Promise<UpdateTransactionCategoryResult> {
  return withUserScope(userId, async (tx) => {
    const existing = await tx.notableTransaction.findFirst({ where: { id, userId } });
    if (!existing) return null;

    const category = await tx.category.findFirst({ where: { id: categoryId, userId } });
    if (!category) return null;

    const updated = await tx.notableTransaction.update({
      where: { id },
      data: { categoryId, needsReview: false },
      include: { category: true, bankAccount: true },
    });

    if (embedding) {
      const merchantText = updated.merchantName ?? updated.description;
      const merchantKey = normalizeMerchantKey(merchantText);
      await tx.merchantEmbedding.upsert({
        where: { userId_merchantKey: { userId, merchantKey } },
        create: {
          userId,
          merchantKey,
          sampleMerchantName: merchantText,
          categoryId,
          embedding: [...embedding],
          embeddingModel: CURRENT_EMBEDDING_MODEL_ID,
        },
        update: {
          sampleMerchantName: merchantText,
          categoryId,
          embedding: [...embedding],
          embeddingModel: CURRENT_EMBEDDING_MODEL_ID,
        },
      });

      // Reuses the SAME embedding already computed for the merchant
      // feedback loop above — this text (merchant/description) is what
      // a search query would semantically match against too, so
      // there's no reason to ask the client to compute it twice for
      // one correction (AGENTS.md §3cc).
      await setSearchEmbedding(tx, updated.id, embedding);
    }

    return updated;
  });
}

export async function countNeedsReview(userId: string): Promise<number> {
  return withUserScope(userId, (tx) => tx.notableTransaction.count({ where: { userId, needsReview: true } }));
}

export type CreateTransactionInput = {
  bankAccountId: string;
  /** Signed agorot — negative for an expense, positive for income. */
  amountAgorot: bigint;
  occurredAt: Date;
  description: string;
  merchantName?: string;
  /**
   * The Self-Learning Vector Categorization Engine's similarity match
   * (AGENTS.md §3u) — a 384-dimension embedding for this transaction's
   * merchant text, computed client-side by
   * src/lib/embeddings/local-embedder.ts. Optional: when present, Tier 3
   * KNN joins Tiers 1-2 in the cascade (still gated by the cascade's own
   * "both merchantEmbedding AND embeddingCorrections must be present"
   * rule — see cascade.ts); when absent (an older client, or a browser
   * where the local model failed to load), categorization falls back to
   * exactly the Tier 1-2-only behavior this function already had, same
   * as CSV bulk import still does on purpose (see the reasoning below).
   */
  embedding?: readonly number[];
};

/**
 * Manual transaction entry (AGENTS.md §3q). ILS-only, matching the CSV
 * pipeline's own precedent (`src/lib/csv-import/`, §3j: "Foreign-currency
 * rows are refused, not converted") — a receipt or a hand-typed entry is
 * exactly the same kind of untrusted free text a CSV row is, so it gets
 * the same formula-injection neutralization. Tier 4 (a live Anthropic
 * call) is still deliberately out of the critical path of a single
 * interactive submission, same reasoning as CSV bulk import — but Tier 3
 * is now genuinely reachable here (§3u), unlike CSV import: computing a
 * *client-side* embedding for one interactively-submitted transaction
 * costs nothing extra round-trip-wise, whereas embedding potentially
 * hundreds of CSV rows in-browser before a single upload would be a much
 * bigger, unrequested UX change — so CSV import intentionally keeps its
 * existing Tier 1-2-only scope (`src/server/dal/transaction-import.ts`
 * is unchanged by this pass).
 *
 * `isManual: true` here is the correct, already-documented flag for
 * this (§3j: "`isManual` means... manually *entered*") — this is the
 * first code path that actually sets it.
 */
export async function createTransaction(userId: string, input: CreateTransactionInput) {
  return withUserScope(userId, async (tx) => {
    const account = await tx.bankAccount.findFirst({ where: { id: input.bankAccountId, userId } });
    if (!account) throw new BankAccountNotFoundError();

    const categories = await tx.category.findMany({ where: { userId, archivedAt: null } });
    const uncategorized = categories.find((category) => category.isUncategorized);
    if (!uncategorized) throw new Error(`User ${userId} has no uncategorized category`);
    const categoryIdBySlug = new Map(categories.map((category) => [category.slug, category.id]));

    const description = neutralizeFormulaInjection(input.description);
    const merchantName = input.merchantName ? neutralizeFormulaInjection(input.merchantName) : undefined;
    const merchantText = merchantName ?? description;

    const priorRows = await tx.notableTransaction.findMany({
      where: { userId },
      select: { merchantName: true, description: true, categoryId: true, needsReview: true },
    });
    const pastOccurrences: PastOccurrence[] = priorRows
      .filter((prior) => normalizeMerchantKey(prior.merchantName ?? prior.description) === normalizeMerchantKey(merchantText))
      .map((prior) => ({ categoryId: prior.categoryId, isManual: !prior.needsReview }));

    const embeddingCorrections = input.embedding
      ? (
          await tx.merchantEmbedding.findMany({
            where: { userId, embeddingModel: CURRENT_EMBEDDING_MODEL_ID },
            select: { categoryId: true, embedding: true },
          })
        ).map((row) => ({ categoryId: row.categoryId, embedding: row.embedding }))
      : undefined;

    const suggestion = await categorizeTransaction({
      merchantText,
      pastOccurrences,
      resolveCategoryIdBySlug: (slug) => categoryIdBySlug.get(slug),
      uncategorizedCategoryId: uncategorized.id,
      merchantEmbedding: input.embedding,
      embeddingCorrections,
    });

    const created = await tx.notableTransaction.create({
      data: {
        userId,
        bankAccountId: input.bankAccountId,
        categoryId: suggestion.categoryId,
        occurredAt: input.occurredAt,
        currency: "ILS",
        amount: input.amountAgorot,
        nativeAmount: input.amountAgorot,
        description,
        merchantName,
        isManual: true,
        needsReview: suggestion.confidence < 0.5,
      },
      include: { category: true, bankAccount: true },
    });

    // Same embedding already computed for Tier 3 categorization above,
    // reused as this row's semantic search index (AGENTS.md §3cc) — no
    // second client-side computation needed for the same text.
    if (input.embedding) {
      await setSearchEmbedding(tx, created.id, input.embedding);
    }

    return created;
  });
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
