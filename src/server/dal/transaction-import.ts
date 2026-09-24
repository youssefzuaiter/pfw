import "server-only";
import { categorizeTransaction } from "../../lib/categorization/cascade";
import { applyRules, type TransactionRuleData } from "../../lib/categorization/rule-engine";
import type { PastOccurrence } from "../../lib/categorization/types";
import type { CanonicalImportRow } from "../../lib/csv-import/types";
import { BASE_CURRENCY, type CurrencyCode } from "../../lib/currency";
import { convertNativeAmountToAgorot } from "../../lib/exchange-rate";
import { normalizeMerchantKey } from "../../lib/text-matching";
import { buildProviderTransactionId as buildSharedProviderTransactionId } from "../../lib/transaction-dedupe";
import { syncExchangeRates } from "../currency/rate-sync";
import { withUserScope } from "../db/with-user-scope";
import { getOrCreateUncategorizedCategory } from "./categories";
import { getLatestRateFetchedAt, getLatestRateTable } from "./exchange-rates";
import { fetchActiveRulesForEvaluation } from "./transaction-rules";

/** Bulk imports write row-by-row (see with-user-scope.ts) — well above Prisma's 5s default. */
const IMPORT_TRANSACTION_TIMEOUT_MS = 120_000;

export class BankAccountNotFoundError extends Error {
  readonly code = "bank_account_not_found";
  constructor() {
    super("Bank account not found");
    this.name = "BankAccountNotFoundError";
  }
}

/**
 * The parsed rows are in a different currency than the target account.
 * The pipeline parses in the account's currency by construction (the
 * route passes `account.currency` as `expectedCurrency`), so reaching
 * this means a caller wired the two up inconsistently — defense in
 * depth, not an expected user-facing path.
 */
export class ImportCurrencyMismatchError extends Error {
  readonly code = "currency_mismatch";
  constructor(
    readonly accountCurrency: CurrencyCode,
    readonly rowCurrency: CurrencyCode,
  ) {
    super(`Rows are in ${rowCurrency} but the account is in ${accountCurrency}`);
    this.name = "ImportCurrencyMismatchError";
  }
}

/**
 * A foreign-currency account has no REAL synced exchange rate yet, and
 * fetching one on demand didn't produce it either. Refusing is the only
 * correct answer: `amount` and `exchangeRateAtEntry` are frozen
 * historical facts (AGENTS.md §3k), and freezing `FALLBACK_RATES`'s
 * hardcoded guess into hundreds of rows would silently misprice a whole
 * statement in a way that is never recomputed. Today's dashboard
 * conversions may degrade to the fallback (law #5 — a live figure);
 * an immutable one may not.
 */
export class NoExchangeRateError extends Error {
  readonly code = "no_exchange_rate";
  constructor(readonly currency: CurrencyCode) {
    super(
      `No exchange rate for ${currency} has been synced yet, so these rows can't be converted to shekels. Run the rate sync (npm run sync:rates) and try again.`,
    );
    this.name = "NoExchangeRateError";
  }
}

/** Prisma's unique-constraint violation. Matched structurally rather than via `instanceof PrismaClientKnownRequestError`, which would mean importing the generated client into a module that otherwise only needs the scoped transaction type. */
function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

/**
 * CSV import's own call into the shared dedupe mechanism
 * (`src/lib/transaction-dedupe.ts`, extracted for EU Open Banking PSD2
 * Ingestion's sync path to reuse too) — `"csv"` as the source, the
 * adapter id as the source id, producing byte-for-byte the same keys
 * this app has always stored (`csv:${adapterId}:ref:...` /
 * `csv:${adapterId}:hash:...`), so already-imported rows' meaning is
 * completely unaffected by this refactor.
 */
export function buildProviderTransactionId(row: Parameters<typeof buildSharedProviderTransactionId>[0], adapterId: string): string {
  return buildSharedProviderTransactionId(row, "csv", adapterId);
}

export type ImportSummary = {
  importedCount: number;
  duplicateCount: number;
  /** Row-level failures surfaced by the parser, passed through unchanged so the route can report parse and write outcomes together. */
  importedIds: string[];
};

/**
 * Where the import's conversion rate comes from. Injectable as one seam
 * because `ExchangeRate` is a global, non-user-scoped table: a test that
 * needs "no rate exists for TRY" can't arrange that in the shared dev
 * database without racing every other test file that reads the real
 * rows, so tests hand in a fake source instead. Production callers leave
 * it at the default (the real DAL reads + the Frankfurter sync).
 */
export type ImportRateSource = {
  getLatestRateFetchedAt: (currency: CurrencyCode) => Promise<Date | null>;
  getLatestRateTable: () => Promise<Readonly<Record<CurrencyCode, number>>>;
  syncRates: () => Promise<unknown>;
};

const DEFAULT_RATE_SOURCE: ImportRateSource = {
  getLatestRateFetchedAt,
  getLatestRateTable: () => getLatestRateTable(),
  syncRates: () => syncExchangeRates(),
};

export type ImportTransactionsInput = {
  bankAccountId: string;
  adapterId: string;
  rows: readonly CanonicalImportRow[];
  rateSource?: ImportRateSource;
};

/**
 * Resolves the one conversion rate every row of this import is frozen
 * at. ILS needs none (returns `null` without touching the source at
 * all). For any other currency, a REAL stored rate is required — never
 * `FALLBACK_RATE_TABLE`'s guess (see `NoExchangeRateError`): if nothing
 * has ever been synced for it, one sync is attempted on demand (the
 * first import into a brand-new TRY account shouldn't fail just because
 * the nightly cron hasn't run yet), and if that still leaves no row, the
 * import is refused.
 *
 * Accepted, documented limitation: the whole statement converts at the
 * rate current at import time, not per-row historical rates — exactly
 * the trade-off the PSD2 sync path (`sync-service.ts`) already makes,
 * and the reason `exchangeRateAtEntry` is stored per row at all: the
 * rate each row was actually booked at is on the row, auditable.
 */
export async function resolveImportRate(
  currency: CurrencyCode,
  source: ImportRateSource = DEFAULT_RATE_SOURCE,
): Promise<number | null> {
  if (currency === BASE_CURRENCY) return null;

  if ((await source.getLatestRateFetchedAt(currency)) === null) {
    try {
      await source.syncRates();
    } catch {
      // A sync failure (including the stale-data circuit breaker firing
      // for some OTHER currency) is not this import's error to surface;
      // the re-check below decides.
    }
    if ((await source.getLatestRateFetchedAt(currency)) === null) {
      throw new NoExchangeRateError(currency);
    }
  }

  return (await source.getLatestRateTable())[currency];
}

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
 *
 * Categorization now runs a Tier 0 pass first (`rule-engine.ts`, user-
 * defined deterministic rules) ahead of the existing Tiers 1-2 — see the
 * per-row Tier 0 block below for exactly what bypasses what.
 */
export async function importTransactions(
  userId: string,
  input: ImportTransactionsInput,
): Promise<ImportSummary> {
  // The account's currency decides whether a rate is needed at all, and
  // resolving one may hit the network (an on-demand sync) — neither
  // belongs inside the long-running write transaction below, so the
  // account is read in its own short scoped read first.
  const account = await withUserScope(userId, (tx) =>
    tx.bankAccount.findFirst({ where: { id: input.bankAccountId, userId }, select: { id: true, currency: true } }),
  );
  // Same convention as every other DAL getter: an account that isn't
  // this user's is indistinguishable from one that doesn't exist.
  if (!account) throw new BankAccountNotFoundError();

  const currency = account.currency as CurrencyCode;
  for (const row of input.rows) {
    if (row.currency !== currency) throw new ImportCurrencyMismatchError(currency, row.currency);
  }

  const rate = await resolveImportRate(currency, input.rateSource);

  return withUserScope(
    userId,
    async (tx) => {

      const categories = await tx.category.findMany({ where: { userId, archivedAt: null } });
      let uncategorized = categories.find((category) => category.isUncategorized);
      if (!uncategorized) {
        uncategorized = await getOrCreateUncategorizedCategory(tx, userId);
        categories.push(uncategorized);
      }

      const categoryIdBySlug = new Map(categories.map((category) => [category.slug, category.id]));

      // Tier 0 of the categorization pipeline (rule-engine.ts) — fetched
      // once for the whole import, same reasoning `categories`/`priorRows`
      // are fetched once above rather than per row. Uses the ALREADY-OPEN
      // `tx` from this withUserScope block (fetchActiveRulesForEvaluation,
      // not listActiveTransactionRulesForEvaluation) — opening a second,
      // nested scoped transaction here would grab a second connection
      // from the pool mid-import for no reason.
      const activeRules = await fetchActiveRulesForEvaluation(tx, userId);

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

        // The ILS figure this row is booked at — frozen here, with the
        // rate it was converted at, never recomputed (AGENTS.md §3k). For
        // an ILS account `convertNativeAmountToAgorot` is the identity
        // and never reads the rate (`rate` is null there).
        const amountAgorot = convertNativeAmountToAgorot(row.nativeAmount, currency, rate ?? 1);

        // Tier 0: user-defined deterministic rules, evaluated BEFORE the
        // cascade below. Rename/flag actions always apply regardless of
        // whether a rule also set a category; a resolved `categorySlug`
        // BYPASSES Tiers 1-4 entirely for this row (a rule matching a
        // slug this user has no category for falls through to the
        // cascade instead of erroring, same reasoning Tier 2's own
        // slug-resolution failure already falls through in cascade.ts).
        // Rules match on the converted ILS amount — a user's "over ₪500"
        // rule means shekels regardless of which account the row came
        // from.
        const tier0Input: TransactionRuleData = {
          merchantName: row.merchantName,
          description: row.description,
          amountAgorot,
        };
        const tier0 = applyRules(tier0Input, activeRules);
        const tier0CategoryId = tier0.categorySlug ? categoryIdBySlug.get(tier0.categorySlug) : undefined;

        let categoryId: string;
        let confidence: number;
        if (tier0CategoryId) {
          categoryId = tier0CategoryId;
          // A matched, deterministic, user-authored rule is treated as
          // fully confident — at least as confident as Tier 2's app-default
          // keyword rules (0.9), since a user's own explicit rule
          // outranks a generic default.
          confidence = 1;
        } else {
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
          categoryId = suggestion.categoryId;
          confidence = suggestion.confidence;
        }

        const finalMerchantName = tier0.renamedMerchantName ?? row.merchantName;
        const finalNeedsReview = tier0.forceNeedsReview ?? confidence < 0.5;

        let createdId: string;
        try {
          const created = await tx.notableTransaction.create({
            data: {
              userId,
              bankAccountId: input.bankAccountId,
              categoryId,
              providerTransactionId,
              occurredAt: row.occurredAt,
              // The pipeline parses every row in the ACCOUNT's currency
              // and refuses a row whose currency cell says otherwise
              // (src/lib/csv-import/, AGENTS.md §3j/§3bbb) — so
              // `nativeAmount` is what the bank stated, `amount` is its
              // ILS conversion at `rate`, and both are frozen facts.
              currency,
              nativeAmount: BigInt(row.nativeAmount),
              amount: BigInt(amountAgorot),
              exchangeRateAtEntry: rate === null ? null : rate.toString(),
              description: row.description,
              // A Tier 0 `rename` action overrides the imported merchant
              // name; otherwise unchanged.
              merchantName: finalMerchantName,
              isManual: false,
              // Anything the cascade couldn't confidently place is
              // flagged for the user, UNLESS a Tier 0 `flag` action
              // explicitly forced this one way or the other.
              needsReview: finalNeedsReview,
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
        bucket.push({ categoryId, isManual: false });
        pastByMerchant.set(key, bucket);
      }

      return { importedCount, duplicateCount, importedIds };
    },
    { timeoutMs: IMPORT_TRANSACTION_TIMEOUT_MS },
  );
}

/**
 * How many of these rows this user has already imported.
 *
 * Exists so the PREVIEW can say so before anything is written. The dry
 * run parses the file and nothing else, so after a successful import it
 * still reported "211 rows ready" — the same wording as the first time,
 * with no hint that all 211 were already in the ledger. Dedupe does hold
 * (`importTransactions` pre-checks, and the unique constraint backs it),
 * but a preview that cannot show it leaves the user to trust an
 * irreversible button, which is the wrong way round.
 *
 * Read-only and outside any write transaction: this only ever informs a
 * preview, and the import path does its own check inside the transaction
 * that actually writes.
 */
export async function countAlreadyImported(
  userId: string,
  rows: readonly CanonicalImportRow[],
  adapterId: string,
): Promise<number> {
  if (rows.length === 0) return 0;

  const keys = rows.map((row) => buildProviderTransactionId(row, adapterId));
  return withUserScope(userId, (tx) =>
    tx.notableTransaction.count({ where: { userId, providerTransactionId: { in: keys } } }),
  );
}
