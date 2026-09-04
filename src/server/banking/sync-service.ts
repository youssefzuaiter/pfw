import "server-only";
import { categorizeTransaction } from "../../lib/categorization/cascade";
import { applyRules, type TransactionRuleData } from "../../lib/categorization/rule-engine";
import type { PastOccurrence } from "../../lib/categorization/types";
import { fetchTransactions, findMockInstitution, Psd2ApiError, type Psd2Transaction } from "../../lib/banking/psd2-client";
import { parseDecimalToNativeAmount } from "../../lib/currency";
import { convertNativeAmountToAgorot } from "../../lib/exchange-rate";
import { normalizeMerchantKey } from "../../lib/text-matching";
import { assignDedupeKeys, buildProviderTransactionId } from "../../lib/transaction-dedupe";
import { withUserScope } from "../db/with-user-scope";
import { getLatestRateTable } from "../dal/exchange-rates";
import { fetchActiveRulesForEvaluation } from "../dal/transaction-rules";

/** Bulk ingestion writes row-by-row (see with-user-scope.ts's own doc comment on why `createMany` can't be used with the encrypted-fields extension) — well above Prisma's 5s default, same reasoning `IMPORT_TRANSACTION_TIMEOUT_MS` already gives for CSV import. */
const SYNC_TRANSACTION_TIMEOUT_MS = 60_000;

function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

export type SyncResult =
  | { ok: true; importedCount: number; duplicateCount: number }
  | { ok: false; error: "connection_not_found" | "connection_expired" | "connection_revoked" | "sync_failed"; message?: string };

/**
 * Runs one sync cycle for a `BankConnection`: fetches (mock) transactions
 * since the last successful sync, converts each from its native EUR/GBP
 * amount to ILS agorot via the live/fallback exchange rate
 * (`getLatestRateTable`, §3l's established pattern — same live-rate
 * source `computeLiveNetWorth`/`dal/portfolio.ts` already use, frozen
 * onto `exchangeRateAtEntry` as a historical fact, matching every other
 * "converted once, at execution/entry time, never re-converted" value in
 * this app), and writes them as `NotableTransaction` rows through the
 * SAME dedupe mechanism CSV import uses
 * (`src/lib/transaction-dedupe.ts`) — namespaced `"psd2"` + institutionId,
 * distinct from CSV's `"csv"` namespace.
 *
 * KNOWN, DELIBERATE non-goal, stated plainly rather than glossed over:
 * this does NOT attempt to unify a PSD2-synced transaction with a
 * content-identical CSV-imported one from the same real-world event —
 * each source's rows get their own provider id, so both would be
 * inserted if a user both CSV-imported and API-synced overlapping
 * history. True cross-source content matching is a genuinely hard
 * problem even for production aggregators (different formatting/
 * rounding/timing between a bank's CSV export and its live API), and
 * solving it wasn't this feature's actual ask — "safely merge" here
 * means REPEATED syncs (and CSV imports, independently) coexist
 * idempotently, which this genuinely achieves: the mock client's own
 * per-institution history is deterministic (`psd2-client.ts`'s own doc
 * comment), so syncing twice reliably reports every previously-imported
 * row as a duplicate, not a fresh insert.
 *
 * Runs Tier 0-2 categorization only, same reasoning CSV import's own
 * doc comment already gives: Tier 3 needs the embedding sidecar and
 * Tier 4 needs a live Anthropic call, neither of which belongs in the
 * critical path of a sync that could return many rows at once.
 */
export async function syncBankConnection(userId: string, connectionId: string): Promise<SyncResult> {
  const connection = await withUserScope(userId, (tx) => tx.bankConnection.findFirst({ where: { id: connectionId, userId } }));
  if (!connection) return { ok: false, error: "connection_not_found" };
  if (connection.status === "REVOKED") return { ok: false, error: "connection_revoked" };

  if (connection.expiresAt < new Date()) {
    await withUserScope(userId, (tx) => tx.bankConnection.update({ where: { id: connectionId }, data: { status: "EXPIRED" } }));
    return { ok: false, error: "connection_expired" };
  }

  const institution = findMockInstitution(connection.institutionId);
  if (!institution) return { ok: false, error: "connection_not_found" };

  // The FIRST sync (lastSyncedAt still null) must pull the mock client's
  // FULL available history, not just "since the connection was created a
  // moment ago" — the mock client anchors its generated dates to real
  // "now" regardless of when the connection itself was created
  // (psd2-client.ts's own doc comment), so using `connection.createdAt`
  // here would return almost nothing on a brand-new connection. A real
  // PSD2 API's first sync after consent behaves the same way: it backs
  // up as far as the consent scope allows, not from the moment of
  // consent forward.
  const since = connection.lastSyncedAt ?? new Date(0);

  let transactions: Psd2Transaction[];
  try {
    transactions = await fetchTransactions(connection.institutionId, since);
  } catch (error) {
    await withUserScope(userId, (tx) => tx.bankConnection.update({ where: { id: connectionId }, data: { status: "ERROR" } }));
    const message = error instanceof Psd2ApiError ? error.message : "Sync failed";
    return { ok: false, error: "sync_failed", message };
  }

  const rateTable = await getLatestRateTable();
  const rate = rateTable[institution.currency];

  const rows = transactions.map((transaction) => {
    const nativeAmount = parseDecimalToNativeAmount(transaction.transactionAmount.amount);
    const amountAgorot = convertNativeAmountToAgorot(nativeAmount, institution.currency, rate);
    const merchantName = transaction.creditorName ?? transaction.debtorName ?? null;
    const description = transaction.remittanceInformationUnstructured ?? merchantName ?? "PSD2 transaction";
    return {
      occurredAt: new Date(`${transaction.bookingDate}T00:00:00.000Z`),
      amountAgorot,
      nativeAmount,
      description,
      merchantName,
      providerReference: transaction.transactionId,
    };
  });

  const rowsWithKeys = assignDedupeKeys(rows);

  const summary = await withUserScope(
    userId,
    async (tx) => {
      const categories = await tx.category.findMany({ where: { userId, archivedAt: null } });
      const uncategorized = categories.find((category) => category.isUncategorized);
      if (!uncategorized) throw new Error(`User ${userId} has no uncategorized category`);
      const categoryIdBySlug = new Map(categories.map((category) => [category.slug, category.id]));

      const activeRules = await fetchActiveRulesForEvaluation(tx, userId);

      const priorRows = await tx.notableTransaction.findMany({
        where: { userId },
        select: { merchantName: true, description: true, categoryId: true, needsReview: true },
      });
      const pastByMerchant = new Map<string, PastOccurrence[]>();
      for (const prior of priorRows) {
        const key = normalizeMerchantKey(prior.merchantName ?? prior.description);
        const bucket = pastByMerchant.get(key) ?? [];
        bucket.push({ categoryId: prior.categoryId, isManual: !prior.needsReview });
        pastByMerchant.set(key, bucket);
      }

      let importedCount = 0;
      let duplicateCount = 0;

      for (const row of rowsWithKeys) {
        const providerTransactionId = buildProviderTransactionId(row, "psd2", connection.institutionId);

        const existing = await tx.notableTransaction.findFirst({ where: { userId, providerTransactionId }, select: { id: true } });
        if (existing) {
          duplicateCount += 1;
          continue;
        }

        const merchantText = row.merchantName ?? row.description;
        const tier0Input: TransactionRuleData = {
          merchantName: row.merchantName,
          description: row.description,
          amountAgorot: row.amountAgorot,
        };
        const tier0 = applyRules(tier0Input, activeRules);
        const tier0CategoryId = tier0.categorySlug ? categoryIdBySlug.get(tier0.categorySlug) : undefined;

        let categoryId: string;
        let confidence: number;
        if (tier0CategoryId) {
          categoryId = tier0CategoryId;
          confidence = 1;
        } else {
          const suggestion = await categorizeTransaction({
            merchantText,
            pastOccurrences: pastByMerchant.get(normalizeMerchantKey(merchantText)) ?? [],
            resolveCategoryIdBySlug: (slug) => categoryIdBySlug.get(slug),
            uncategorizedCategoryId: uncategorized.id,
          });
          categoryId = suggestion.categoryId;
          confidence = suggestion.confidence;
        }

        const finalMerchantName = tier0.renamedMerchantName ?? row.merchantName;
        const finalNeedsReview = tier0.forceNeedsReview ?? confidence < 0.5;

        try {
          await tx.notableTransaction.create({
            data: {
              userId,
              bankAccountId: connection.bankAccountId,
              categoryId,
              providerTransactionId,
              occurredAt: row.occurredAt,
              currency: institution.currency,
              nativeAmount: BigInt(row.nativeAmount),
              amount: BigInt(row.amountAgorot),
              exchangeRateAtEntry: rate.toString(),
              description: row.description,
              merchantName: finalMerchantName,
              isManual: false,
              needsReview: finalNeedsReview,
            },
          });
        } catch (error) {
          if (isUniqueConstraintViolation(error)) {
            duplicateCount += 1;
            continue;
          }
          throw error;
        }

        importedCount += 1;

        const key = normalizeMerchantKey(merchantText);
        const bucket = pastByMerchant.get(key) ?? [];
        bucket.push({ categoryId, isManual: false });
        pastByMerchant.set(key, bucket);
      }

      await tx.bankConnection.update({ where: { id: connectionId }, data: { status: "ACTIVE", lastSyncedAt: new Date() } });

      return { importedCount, duplicateCount };
    },
    { timeoutMs: SYNC_TRANSACTION_TIMEOUT_MS },
  );

  return { ok: true, ...summary };
}
