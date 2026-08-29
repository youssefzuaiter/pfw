import "server-only";
import { createHash } from "node:crypto";
import { categorizeTransaction } from "../../lib/categorization/cascade";
import type { PastOccurrence } from "../../lib/categorization/types";
import type { CanonicalImportRow } from "../../lib/csv-import/types";
import { normalizeMerchantKey } from "../../lib/text-matching";
import { withUserScope } from "../db/with-user-scope";

/** Bulk imports write row-by-row (see with-user-scope.ts) — well above Prisma's 5s default. */
const IMPORT_TRANSACTION_TIMEOUT_MS = 120_000;

export class BankAccountNotFoundError extends Error {
  readonly code = "bank_account_not_found";
  constructor() {
    super("Bank account not found");
    this.name = "BankAccountNotFoundError";
  }
}

/** Prisma's unique-constraint violation. Matched structurally rather than via `instanceof PrismaClientKnownRequestError`, which would mean importing the generated client into a module that otherwise only needs the scoped transaction type. */
function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

/**
 * Builds the value stored in `NotableTransaction.providerTransactionId`,
 * which the schema's `@@unique([userId, providerTransactionId])` turns
 * into the actual replay guard.
 *
 * Namespaced by source so a bank's own reference `"12345"` can never
 * collide with an unrelated content hash that happens to be `"12345"`,
 * and so a future importer (a different bank, an API sync) can't collide
 * with CSV-imported rows either.
 *
 * The content-hash branch is the "content-hash fallback" docs/SECURITY.md
 * §3.3 calls for: without it, rows from a bank that supplies no
 * reference number would each get `providerTransactionId = null`, and
 * Postgres does **not** treat NULLs as equal in a unique index — so
 * every re-import would insert a full duplicate set of rows with no
 * constraint violation at all. That's the exact "re-importing the same
 * statement inflates balances" failure the guard exists to prevent, and
 * it fails silently, which is why the fallback is mandatory rather than
 * a nicety.
 */
export function buildProviderTransactionId(row: CanonicalImportRow, adapterId: string): string {
  if (row.providerReference) {
    return `csv:${adapterId}:ref:${row.providerReference}`;
  }
  const digest = createHash("sha256").update(row.dedupeKeySource).digest("hex").slice(0, 32);
  return `csv:${adapterId}:hash:${digest}`;
}

export type ImportSummary = {
  importedCount: number;
  duplicateCount: number;
  /** Row-level failures surfaced by the parser, passed through unchanged so the route can report parse and write outcomes together. */
  importedIds: string[];
};

export type ImportTransactionsInput = {
  bankAccountId: string;
  adapterId: string;
  rows: readonly CanonicalImportRow[];
};

/**
 * Writes parsed statement rows as `NotableTransaction`s, skipping any
 * whose `providerTransactionId` already exists for this user.
 *
 * Deduplication is enforced twice, on purpose — the same belt-and-braces
 * pattern the rest of this app uses for scoping (DAL `where` + RLS) and
 * idempotency (in-memory cache + DB constraint):
 *  1. An explicit pre-check inside the transaction, which is what lets a
 *     duplicate be *reported* to the user as skipped rather than blowing
 *     up the import.
 *  2. The database's own `@@unique([userId, providerTransactionId])`,
 *     which is what actually holds under concurrency — two simultaneous
 *     uploads of the same file can both pass step 1, and the constraint
 *     is what stops the loser. That race is caught per-row and counted as
 *     a duplicate rather than failing the whole import.
 *
 * Runs in a single transaction: a statement import is all-or-nothing, so
 * a failure halfway through can't leave a half-imported month behind for
 * the user to reconcile by hand.
 */
export async function importTransactions(
  userId: string,
  input: ImportTransactionsInput,
): Promise<ImportSummary> {
  return withUserScope(
    userId,
    async (tx) => {
      const account = await tx.bankAccount.findFirst({ where: { id: input.bankAccountId, userId } });
      // Same convention as every other DAL getter: an account that isn't
      // this user's is indistinguishable from one that doesn't exist.
      if (!account) throw new BankAccountNotFoundError();

      const categories = await tx.category.findMany({ where: { userId, archivedAt: null } });
      const uncategorized = categories.find((category) => category.isUncategorized);
      if (!uncategorized) throw new Error(`User ${userId} has no uncategorized category`);

      const categoryIdBySlug = new Map(categories.map((category) => [category.slug, category.id]));

      // Tier 1 of the cascade learns from what this user has already
      // categorized, so imported rows inherit prior manual corrections
      // instead of every import starting from scratch.
      const priorRows = await tx.notableTransaction.findMany({
        where: { userId },
        select: { merchantName: true, description: true, categoryId: true, needsReview: true },
      });
      const pastByMerchant = new Map<string, PastOccurrence[]>();
      for (const prior of priorRows) {
        const key = normalizeMerchantKey(prior.merchantName ?? prior.description);
        const bucket = pastByMerchant.get(key) ?? [];
        // `!needsReview` is a *proxy* for Tier 1's `isManual` ("the user
        // categorized this by hand"), not the real signal — the schema
        // has no dedicated "category was user-corrected" column, and
        // `NotableTransaction.isManual` means something different
        // (manually *entered*, i.e. not imported). What `!needsReview`
        // actually means is "this row's category is settled", which
        // includes seeded rows the user never touched. That's a
        // deliberate, slightly-loose read: for an import, matching how
        // this merchant is already filed in the ledger is the behavior
        // we want, and Tier 2's keyword rules still backstop anything
        // with no history. Worth a real `categoryConfirmedAt` column if
        // Tier 1 precision ever matters more than this.
        bucket.push({ categoryId: prior.categoryId, isManual: !prior.needsReview });
        pastByMerchant.set(key, bucket);
      }

      let importedCount = 0;
      let duplicateCount = 0;
      const importedIds: string[] = [];

      for (const row of input.rows) {
        const providerTransactionId = buildProviderTransactionId(row, input.adapterId);

        const existing = await tx.notableTransaction.findFirst({
          where: { userId, providerTransactionId },
          select: { id: true },
        });
        if (existing) {
          duplicateCount += 1;
          continue;
        }

        const merchantText = row.merchantName ?? row.description;
        const suggestion = await categorizeTransaction({
          merchantText,
          pastOccurrences: pastByMerchant.get(normalizeMerchantKey(merchantText)) ?? [],
          resolveCategoryIdBySlug: (slug) => categoryIdBySlug.get(slug),
          uncategorizedCategoryId: uncategorized.id,
          // Tiers 3 and 4 are deliberately not wired in here: Tier 3
          // needs the embedding sidecar and Tier 4 needs a live Anthropic
          // call, neither of which should sit in the critical path of a
          // bulk file upload (a 300-row statement would mean 300 network
          // round-trips). Anything the deterministic tiers can't place
          // lands in the review queue below, which is exactly what that
          // queue is for.
        });

        let createdId: string;
        try {
          const created = await tx.notableTransaction.create({
            data: {
              userId,
              bankAccountId: input.bankAccountId,
              categoryId: suggestion.categoryId,
              providerTransactionId,
              occurredAt: row.occurredAt,
              amount: BigInt(row.amountAgorot),
              // The CSV pipeline refuses foreign-currency rows outright
              // (src/lib/csv-import/, AGENTS.md §3j — importing a USD
              // amount as shekels would corrupt the ledger by roughly the
              // FX rate), so every imported row is ILS-native: the native
              // amount is the agorot amount, and no conversion happened,
              // hence no exchangeRateAtEntry.
              currency: "ILS",
              nativeAmount: BigInt(row.amountAgorot),
              description: row.description,
              merchantName: row.merchantName,
              isManual: false,
              // Anything the cascade couldn't confidently place is flagged
              // for the user rather than silently filed somewhere wrong.
              needsReview: suggestion.confidence < 0.5,
            },
            select: { id: true },
          });
          createdId = created.id;
        } catch (error) {
          // The pre-check above and this constraint are the two
          // independent halves of the dedupe guarantee (see this
          // function's doc comment): under concurrent uploads of the same
          // file, both requests can pass the pre-check, and the database
          // is what actually stops the second one. Counting it as a
          // duplicate keeps that race a non-event for the user instead of
          // failing an otherwise-valid import.
          if (isUniqueConstraintViolation(error)) {
            duplicateCount += 1;
            continue;
          }
          throw error;
        }

        importedCount += 1;
        importedIds.push(createdId);

        // Feed this row back into Tier 1's input so later rows in the
        // same file benefit from it — without this, a 40-line statement
        // full of the same merchant would consult only pre-import
        // history and re-derive the same answer 40 times.
        const key = normalizeMerchantKey(merchantText);
        const bucket = pastByMerchant.get(key) ?? [];
        bucket.push({ categoryId: suggestion.categoryId, isManual: false });
        pastByMerchant.set(key, bucket);
      }

      return { importedCount, duplicateCount, importedIds };
    },
    { timeoutMs: IMPORT_TRANSACTION_TIMEOUT_MS },
  );
}
