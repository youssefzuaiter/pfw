import "server-only";
import { Prisma } from "../../generated/prisma/client";
import type { Currency } from "../../generated/prisma/client";
import { categorizeTransaction } from "../../lib/categorization/cascade";
import { applyRules, type TransactionRuleData } from "../../lib/categorization/rule-engine";
import type { PastOccurrence } from "../../lib/categorization/types";
import { neutralizeFormulaInjection } from "../../lib/csv-import/formula-injection";
import { CURRENT_EMBEDDING_MODEL_ID } from "../../lib/embeddings/embedding-model";
import { agorot } from "../../lib/money";
import { normalizeMerchantKey } from "../../lib/text-matching";
import { parsePgVectorLiteral, toPgVectorLiteral } from "../../lib/vector-math";
import { withUserScope, type ScopedTransactionClient } from "../db/with-user-scope";
import { getOrCreateUncategorizedCategory } from "./categories";
import { appendLedgerCommit, buildLedgerState } from "./ledger-commits";
import { BankAccountNotFoundError } from "./transaction-import";
import { fetchActiveRulesForEvaluation } from "./transaction-rules";

/** See bank-accounts.ts for why this returns `null` rather than throwing on a mismatch. */
/**
 * The two filters every transaction read needs, defined once.
 *
 * `LIVE` — not soft-deleted. Every read wants this: a deleted row must
 * not appear in a list, a search, a total, or a dedupe check.
 *
 * `REAL_MONEY` — live AND not a transfer. Only for the aggregates that
 * answer "what did I earn or spend": income/expense history, spend by
 * category, envelope balances, burn rate, the anomaly window. A transfer
 * between the user's own accounts is not spending, and counting it as
 * such overstated one real month's income by ~100,000 TRY.
 *
 * Deliberately NOT applied to listings, search, or the ledger view: a
 * transfer really happened and the balance really moved, so hiding it
 * from the user's own history would be a different lie.
 */
export const LIVE = { deletedAt: null } as const;
export const REAL_MONEY = { deletedAt: null, isTransfer: false } as const;

export async function getTransactionById(userId: string, id: string) {
  return withUserScope(userId, (tx) =>
    tx.notableTransaction.findFirst({
      where: { id, userId, ...LIVE },
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
  const where: Prisma.NotableTransactionWhereInput = { userId, ...LIVE };
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
      // The raw ranking query bypasses Prisma's where-builder, so LIVE
      // has to be spelled out here too — a deleted row must not surface
      // in search any more than in a list.
      Prisma.sql`"deletedAt" IS NULL`,
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
      where: { id: { in: ranked.map((r) => r.id) }, userId, ...LIVE },
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

export type SearchEmbeddingExportRow = { transactionId: string; embedding: number[] };

/**
 * Full export of this user's search-embedding vectors — the server-side
 * half of the Local RAG retrieval pipeline (client-side plan doc): the
 * browser caches these vectors in IndexedDB and runs KNN entirely
 * client-side against them, so answering a copilot question never needs
 * to send a raw transaction description to the server just to find
 * which transactions are relevant. Raw SQL is required, same reason
 * `searchTransactionsSemantic` above already needs it — `searchEmbedding`
 * is `Unsupported("vector(384)")`, with no typed Prisma read path — but
 * unlike that function, this one's whole point IS to return the vector
 * itself, not just rank by it. There's no equivalent "$queryRaw bypasses
 * the encryption extension" trap to route around here: nothing this
 * function selects (`id`, the vector) is an encrypted column.
 */
export async function listSearchEmbeddingsForExport(userId: string): Promise<SearchEmbeddingExportRow[]> {
  return withUserScope(userId, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; vector: string }[]>`
      SELECT "id", "searchEmbedding"::text AS "vector"
      FROM "NotableTransaction"
      WHERE "userId" = ${userId} AND "searchEmbedding" IS NOT NULL
    `;
    return rows.map((row) => ({ transactionId: row.id, embedding: parsePgVectorLiteral(row.vector) }));
  });
}

/**
 * Hydrates a client-supplied list of transaction ids into full rows —
 * the server-side half of injecting the browser's local KNN retrieval
 * (Local RAG plan) into a copilot request. The ids come from the
 * browser's own IndexedDB vector cache, itself populated for this exact
 * user by `listSearchEmbeddingsForExport` above, but they still cross a
 * trust boundary as untrusted client input like any other request field
 * — `where: { userId }` (plus RLS underneath, via `withUserScope`) is
 * what actually enforces that: any id that isn't this user's own is
 * silently excluded from the result, never leaked, never an error, same
 * IDOR-safe convention every DAL function in this app already follows.
 */
export async function listTransactionsByIds(userId: string, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return withUserScope(userId, (tx) =>
    tx.notableTransaction.findMany({
      where: { id: { in: [...ids] }, userId, ...LIVE },
      include: { category: true, bankAccount: true },
    }),
  );
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

    // Cryptographic Ledger Versioning (ad hoc) — the next link in this
    // transaction's hash chain, appended inside this SAME withUserScope
    // transaction as the update it documents.
    await appendLedgerCommit(tx, userId, {
      transactionId: updated.id,
      action: "UPDATE",
      state: buildLedgerState({ ...updated, categoryName: updated.category.name }),
    });

    return updated;
  });
}

export async function countNeedsReview(userId: string): Promise<number> {
  return withUserScope(userId, (tx) => tx.notableTransaction.count({ where: { userId, needsReview: true, ...LIVE } }));
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
 *
 * Categorization now runs a Tier 0 pass first (`rule-engine.ts`, user-
 * defined deterministic rules) ahead of the cascade — see the Tier 0
 * block below for exactly what bypasses what.
 */
export async function createTransaction(userId: string, input: CreateTransactionInput) {
  return withUserScope(userId, async (tx) => {
    const account = await tx.bankAccount.findFirst({ where: { id: input.bankAccountId, userId } });
    if (!account) throw new BankAccountNotFoundError();

    const categories = await tx.category.findMany({ where: { userId, archivedAt: null } });
    let uncategorized = categories.find((category) => category.isUncategorized);
    if (!uncategorized) {
      uncategorized = await getOrCreateUncategorizedCategory(tx, userId);
      categories.push(uncategorized);
    }
    const categoryIdBySlug = new Map(categories.map((category) => [category.slug, category.id]));

    const description = neutralizeFormulaInjection(input.description);
    const merchantName = input.merchantName ? neutralizeFormulaInjection(input.merchantName) : undefined;
    const merchantText = merchantName ?? description;

    // Tier 0: user-defined deterministic rules, evaluated BEFORE the
    // cascade below. Uses the ALREADY-OPEN `tx` from this withUserScope
    // block (fetchActiveRulesForEvaluation, not
    // listActiveTransactionRulesForEvaluation) — see that function's own
    // doc comment for why a nested scoped transaction here would be wrong.
    const activeRules = await fetchActiveRulesForEvaluation(tx, userId);
    const tier0Input: TransactionRuleData = {
      merchantName,
      description,
      amountAgorot: agorot(Number(input.amountAgorot)),
    };
    const tier0 = applyRules(tier0Input, activeRules);
    const tier0CategoryId = tier0.categorySlug ? categoryIdBySlug.get(tier0.categorySlug) : undefined;

    let categoryId: string;
    let confidence: number;

    if (tier0CategoryId) {
      // A matched, deterministic, user-authored rule BYPASSES Tiers 1-4
      // entirely for categorization (a rule matching a slug this user has
      // no category for falls through to the cascade instead, same
      // reasoning Tier 2's own slug-resolution failure already falls
      // through in cascade.ts) — treated as fully confident, at least as
      // confident as Tier 2's app-default keyword rules (0.9), since a
      // user's own explicit rule outranks a generic default.
      categoryId = tier0CategoryId;
      confidence = 1;
    } else {
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
      categoryId = suggestion.categoryId;
      confidence = suggestion.confidence;
    }

    // A Tier 0 `rename` action overrides the entered merchant name; a
    // `flag` action overrides the review-queue decision either tier
    // above would otherwise make.
    const finalMerchantName = tier0.renamedMerchantName ?? merchantName;
    const finalNeedsReview = tier0.forceNeedsReview ?? confidence < 0.5;

    const created = await tx.notableTransaction.create({
      data: {
        userId,
        bankAccountId: input.bankAccountId,
        categoryId,
        occurredAt: input.occurredAt,
        currency: "ILS",
        amount: input.amountAgorot,
        nativeAmount: input.amountAgorot,
        description,
        merchantName: finalMerchantName,
        isManual: true,
        needsReview: finalNeedsReview,
        isTransfer: tier0.isTransfer ?? false,
      },
      include: { category: true, bankAccount: true },
    });

    // Same embedding already computed for Tier 3 categorization above,
    // reused as this row's semantic search index (AGENTS.md §3cc) — no
    // second client-side computation needed for the same text.
    if (input.embedding) {
      await setSearchEmbedding(tx, created.id, input.embedding);
    }

    // Cryptographic Ledger Versioning (ad hoc) — the first (CREATE) link
    // in this transaction's hash chain, appended inside this SAME
    // withUserScope transaction as the row it documents (see
    // appendLedgerCommit's own doc comment for why atomicity here isn't
    // optional).
    await appendLedgerCommit(tx, userId, {
      transactionId: created.id,
      action: "CREATE",
      state: buildLedgerState({ ...created, categoryName: created.category.name }),
    });

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
      where: { userId, occurredAt: { gte: from, lt: to }, amount: { lt: 0n }, ...REAL_MONEY },
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
      where: { userId, occurredAt: { gte: from, lt: to }, ...REAL_MONEY },
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

export type DailyNetCashFlow = {
  /** UTC calendar date, ISO `YYYY-MM-DD`. */
  dateKey: string;
  /** Signed net (income − expense) for that day, in agorot. */
  netAgorot: bigint;
};

/**
 * A DENSE daily series — every calendar day in `[from, to)` gets a row,
 * `netAgorot: 0n` for a day with no transactions at all, not a gap in
 * the array (AGENTS.md §3dd). This is the one real difference from
 * `getMonthlyIncomeExpenseHistory` above (which only ever emits a
 * bucket for a month that actually had activity) — the forecaster
 * Worker's LSTM warmup needs a genuinely continuous day-by-day sequence
 * to walk through; a silently-skipped day would shift every later
 * day's position by one, corrupting the day-of-week feature the model
 * was trained to condition on.
 */
export async function getDailyNetCashFlow(userId: string, from: Date, to: Date): Promise<DailyNetCashFlow[]> {
  const rows = await withUserScope(userId, (tx) =>
    tx.notableTransaction.findMany({
      where: { userId, occurredAt: { gte: from, lt: to }, ...REAL_MONEY },
      select: { occurredAt: true, amount: true },
    }),
  );

  const byDay = new Map<string, bigint>();
  for (const row of rows) {
    const dateKey = row.occurredAt.toISOString().slice(0, 10);
    byDay.set(dateKey, (byDay.get(dateKey) ?? 0n) + row.amount);
  }

  const days: DailyNetCashFlow[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  while (cursor < end) {
    const dateKey = cursor.toISOString().slice(0, 10);
    days.push({ dateKey, netAgorot: byDay.get(dateKey) ?? 0n });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return days;
}

export type SpendingAnomalyTransactionRow = {
  /** Full ISO 8601 timestamp — the time-of-day component feeds the client-side burst/velocity feature (src/lib/ml/anomaly-worker-handlers.ts). */
  occurredAtIso: string;
  /** Positive magnitude of an EXPENSE, in agorot. */
  amountAgorot: number;
  categorySlug: string;
};

/**
 * Raw expense-only transaction rows for the client-side spending-anomaly
 * detector (src/lib/ml/anomaly-worker.ts — "Behavioral Spending Anomaly
 * Detection"). Deliberately returns individual transaction rows, not a
 * pre-aggregated daily/category matrix — the aggregation into the
 * model's exact 10-feature shape is the client Worker's job (it has to
 * reproduce ml-pipeline/synthesize_ledger.py's feature definitions
 * exactly), so this function's only responsibility is the RLS-enforced
 * fetch itself. Only negative (expense) amounts are included — income
 * plays no role in a spending-anomaly signal, and is excluded here
 * rather than left for the Worker to filter, so bigint income amounts
 * never need to cross the Server->Client boundary at all.
 *
 * `amount`/`nativeAmount` are `bigint` and cannot cross a Server->Client
 * Component prop boundary any more than they can cross
 * `NextResponse.json()` (AGENTS.md §3d's documented bug class) — the
 * conversion to a plain `number` happens here, in the DAL, once, rather
 * than at every call site.
 */
export async function getRecentExpenseTransactionsForAnomalyDetection(
  userId: string,
  from: Date,
  to: Date,
): Promise<SpendingAnomalyTransactionRow[]> {
  const rows = await withUserScope(userId, (tx) =>
    tx.notableTransaction.findMany({
      where: { userId, occurredAt: { gte: from, lt: to }, amount: { lt: 0n }, ...REAL_MONEY },
      select: { occurredAt: true, amount: true, category: { select: { slug: true } } },
    }),
  );

  return rows.map((row) => ({
    occurredAtIso: row.occurredAt.toISOString(),
    amountAgorot: Number(-row.amount),
    categorySlug: row.category.slug,
  }));
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
      where: { userId, occurredAt: { gte: since }, ...REAL_MONEY },
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

export type DeleteTransactionResult =
  | { ok: true; deletedCount: number }
  | { ok: false; error: "not_found" };

/**
 * Soft-deletes one transaction, recording it on the ledger chain.
 *
 * Soft because a hard delete is impossible by construction: LedgerCommit
 * cascades from this row and is append-only at the database level, so
 * the cascade would be rejected by its own trigger. That constraint
 * points the right way anyway — the reason this exists is that a
 * 211-row import that went in wrong had no way back, and "gone forever"
 * is a worse answer than "hidden and restorable".
 *
 * `providerTransactionId` is RELEASED (set to null) and preserved in the
 * DELETE commit's own snapshot. Without that, undoing a bad import would
 * leave its rows still holding the dedupe keys, so re-importing the
 * corrected file would find nothing new — an undo that cannot be redone.
 * Releasing it also keeps Prisma's `@@unique([userId, providerTransactionId])`
 * exactly as declared, rather than needing a partial index the schema
 * cannot express.
 */
export async function softDeleteTransaction(
  userId: string,
  id: string,
): Promise<DeleteTransactionResult> {
  return withUserScope(userId, async (tx) => {
    const row = await tx.notableTransaction.findFirst({
      where: { id, userId, ...LIVE },
      include: { category: true },
    });
    if (!row) return { ok: false, error: "not_found" };

    await tx.notableTransaction.update({
      where: { id },
      data: { deletedAt: new Date(), providerTransactionId: null },
    });

    await appendLedgerCommit(tx, userId, {
      transactionId: id,
      action: "DELETE",
      // The released key rides along in the snapshot so a restore can
      // put it back.
      state: {
        ...buildLedgerState({ ...row, categoryName: row.category.name }),
        providerTransactionId: row.providerTransactionId,
      },
    });

    return { ok: true, deletedCount: 1 };
  });
}

/**
 * Undoes a soft delete, restoring the dedupe key the DELETE released.
 *
 * If that key has since been taken — the user deleted an import, then
 * re-imported the same file — the row comes back WITHOUT it rather than
 * failing: the live row that now holds the key is the one that should
 * keep it, and refusing the restore would strand this row permanently.
 */
export async function restoreTransaction(
  userId: string,
  id: string,
): Promise<DeleteTransactionResult> {
  return withUserScope(userId, async (tx) => {
    const row = await tx.notableTransaction.findFirst({
      where: { id, userId, deletedAt: { not: null } },
      include: { category: true },
    });
    if (!row) return { ok: false, error: "not_found" };

    const deleteCommit = await tx.ledgerCommit.findFirst({
      where: { userId, transactionId: id, action: "DELETE" },
      orderBy: { createdAt: "desc" },
    });
    const released = (deleteCommit?.patchData as { providerTransactionId?: string | null } | null)
      ?.providerTransactionId;

    const keyIsFree =
      !released ||
      (await tx.notableTransaction.count({ where: { userId, providerTransactionId: released } })) === 0;

    await tx.notableTransaction.update({
      where: { id },
      data: { deletedAt: null, ...(keyIsFree && released ? { providerTransactionId: released } : {}) },
    });

    await appendLedgerCommit(tx, userId, {
      transactionId: id,
      action: "RESTORE",
      state: buildLedgerState({ ...row, categoryName: row.category.name }),
    });

    return { ok: true, deletedCount: 1 };
  });
}

/**
 * Soft-deletes every row written by one statement import.
 *
 * The unit that actually matters: an import writes hundreds of rows at
 * once, so undoing it one row at a time is not an undo. Each row still
 * gets its own ledger commit, because the chain is per-transaction and
 * a batch is not a thing the ledger knows about.
 */
export async function softDeleteImportBatch(
  userId: string,
  importBatchId: string,
): Promise<DeleteTransactionResult> {
  return withUserScope(
    userId,
    async (tx) => {
      const rows = await tx.notableTransaction.findMany({
        where: { userId, importBatchId, ...LIVE },
        include: { category: true },
      });
      if (rows.length === 0) return { ok: false, error: "not_found" as const };

      const deletedAt = new Date();
      for (const row of rows) {
        await tx.notableTransaction.update({
          where: { id: row.id },
          data: { deletedAt, providerTransactionId: null },
        });
        await appendLedgerCommit(tx, userId, {
          transactionId: row.id,
          action: "DELETE",
          state: {
            ...buildLedgerState({ ...row, categoryName: row.category.name }),
            providerTransactionId: row.providerTransactionId,
          },
        });
      }

      return { ok: true as const, deletedCount: rows.length };
    },
    // Same reasoning as importTransactions' own raised timeout: hundreds
    // of single-row updates plus a commit each legitimately exceed
    // Prisma's 5s default.
    { timeoutMs: 120_000 },
  );
}

/** Sets or clears the transfer flag — money between the user's own accounts. */
export async function setTransactionTransfer(
  userId: string,
  id: string,
  isTransfer: boolean,
): Promise<DeleteTransactionResult> {
  return withUserScope(userId, async (tx) => {
    const row = await tx.notableTransaction.findFirst({ where: { id, userId, ...LIVE } });
    if (!row) return { ok: false, error: "not_found" };

    await tx.notableTransaction.update({ where: { id }, data: { isTransfer } });
    return { ok: true, deletedCount: 1 };
  });
}

export type RuleApplicationChange = {
  transactionId: string;
  occurredAt: Date;
  /** What the user sees in the list — merchant when there is one, else the description. */
  label: string;
  categoryFrom: string | null;
  categoryTo: string | null;
  renameTo: string | null;
  transferTo: boolean | null;
};

export type RuleApplicationResult = {
  /** How many rows would change in total — `changes` is only a sample of these. */
  totalChanges: number;
  /** A sample of the rows a rule matched AND would actually change. */
  changes: RuleApplicationChange[];
  /** Rows a rule matched but which already hold the values it would set. */
  alreadyCorrect: number;
  /** Rows skipped because the user had categorised them by hand. */
  protectedByManualChoice: number;
  /** Rows written — always 0 for a dry run. */
  updatedCount: number;
};

/**
 * Runs the Tier-0 rules over transactions ALREADY stored.
 *
 * Rules otherwise only fire at import, manual entry and sync, so a rule
 * written today did nothing for what was already there — which made the
 * feature close to useless in the one situation that calls for it. A
 * real first import left 209 of 211 rows in Uncategorized, and the only
 * remedy was 209 dropdowns.
 *
 * DOES NOT touch a row the user categorised by hand. `needsReview` is
 * the proxy for "a human decided this" (§3j documents why: the schema
 * has no `categoryConfirmedAt`, and `isManual` means manually ENTERED,
 * which is different). So a row is eligible only while it is still
 * Uncategorized or still flagged for review — a deliberate choice is
 * never overwritten by a rule written afterwards.
 *
 * `dryRun` returns exactly what would change and writes nothing, the
 * same shape the statement importer uses, and for the same reason: this
 * can touch hundreds of rows at once and categorisation has no undo.
 */
export async function applyRulesToExistingTransactions(
  userId: string,
  options: { dryRun: boolean; limit?: number },
): Promise<RuleApplicationResult> {
  return withUserScope(
    userId,
    async (tx) => {
      const rules = await fetchActiveRulesForEvaluation(tx, userId);
      if (rules.length === 0) {
        return { totalChanges: 0, changes: [], alreadyCorrect: 0, protectedByManualChoice: 0, updatedCount: 0 };
      }

      const categories = await tx.category.findMany({ where: { userId, archivedAt: null } });
      const categoryIdBySlug = new Map(categories.map((c) => [c.slug, c.id]));
      const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));
      const uncategorizedId = categories.find((c) => c.isUncategorized)?.id ?? null;

      const rows = await tx.notableTransaction.findMany({
        where: { userId, ...LIVE },
        select: {
          id: true,
          occurredAt: true,
          description: true,
          merchantName: true,
          amount: true,
          categoryId: true,
          needsReview: true,
          isTransfer: true,
        },
        orderBy: { occurredAt: "desc" },
      });

      const changes: RuleApplicationChange[] = [];
      let alreadyCorrect = 0;
      let protectedByManualChoice = 0;
      let updatedCount = 0;

      for (const row of rows) {
        const result = applyRules(
          {
            merchantName: row.merchantName,
            description: row.description,
            amountAgorot: agorot(Number(row.amount)),
          },
          rules,
        );
        if (result.matchedRuleIds.length === 0) continue;

        const targetCategoryId = result.categorySlug ? categoryIdBySlug.get(result.categorySlug) : undefined;
        const wantsCategory = targetCategoryId !== undefined && targetCategoryId !== row.categoryId;
        const wantsRename =
          result.renamedMerchantName !== undefined && result.renamedMerchantName !== row.merchantName;
        const wantsTransfer = result.isTransfer !== undefined && result.isTransfer !== row.isTransfer;

        if (!wantsCategory && !wantsRename && !wantsTransfer) {
          alreadyCorrect += 1;
          continue;
        }

        // A hand-categorised row is off limits for the CATEGORY only —
        // renaming and the transfer flag are orthogonal to that choice.
        const handCategorised = !row.needsReview && row.categoryId !== uncategorizedId;
        const applyCategory = wantsCategory && !handCategorised;
        if (wantsCategory && handCategorised) protectedByManualChoice += 1;

        if (!applyCategory && !wantsRename && !wantsTransfer) continue;

        changes.push({
          transactionId: row.id,
          occurredAt: row.occurredAt,
          label: row.merchantName ?? row.description,
          categoryFrom: applyCategory ? (categoryNameById.get(row.categoryId) ?? null) : null,
          categoryTo: applyCategory ? (categoryNameById.get(targetCategoryId!) ?? null) : null,
          renameTo: wantsRename ? (result.renamedMerchantName ?? null) : null,
          transferTo: wantsTransfer ? (result.isTransfer ?? null) : null,
        });

        if (options.dryRun) continue;

        const before = await tx.notableTransaction.findUnique({
          where: { id: row.id },
          include: { category: true },
        });
        if (!before) continue;

        await tx.notableTransaction.update({
          where: { id: row.id },
          data: {
            ...(applyCategory ? { categoryId: targetCategoryId, needsReview: false } : {}),
            ...(wantsRename ? { merchantName: result.renamedMerchantName } : {}),
            ...(wantsTransfer ? { isTransfer: result.isTransfer } : {}),
          },
        });
        updatedCount += 1;

        // Same chain a manual recategorisation writes (§3mm): a rule
        // changing a stored transaction is still a change to it.
        if (applyCategory || wantsRename) {
          const after = await tx.notableTransaction.findUnique({
            where: { id: row.id },
            include: { category: true },
          });
          if (after) {
            await appendLedgerCommit(tx, userId, {
              transactionId: row.id,
              action: "UPDATE",
              state: buildLedgerState({ ...after, categoryName: after.category.name }),
            });
          }
        }
      }

      const limit = options.limit ?? changes.length;
      return {
        totalChanges: changes.length,
        changes: changes.slice(0, limit),
        alreadyCorrect,
        protectedByManualChoice,
        updatedCount,
      };
    },
    // Hundreds of single-row updates plus a ledger commit each, same
    // reasoning as importTransactions' own raised ceiling.
    { timeoutMs: 120_000 },
  );
}
