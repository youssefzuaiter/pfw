import { createHash } from "node:crypto";
import type { Agorot } from "./money";

/**
 * The transaction-ingestion dedupe mechanism EVERY source that writes
 * `NotableTransaction` rows shares — extracted from
 * `src/lib/csv-import/pipeline.ts` (originally CSV-only, private) so EU
 * Open Banking PSD2 Ingestion's sync path (ad hoc) could genuinely reuse
 * it rather than duplicate it, per that feature's own explicit ask
 * ("route through your EXISTING idempotent duplicate detection"). CSV
 * import's own behavior is byte-for-byte unchanged by this move — same
 * function, same output, just relocated and given a source-agnostic
 * name.
 */

export type DedupeableRow = {
  occurredAt: Date;
  amountAgorot: Agorot;
  description: string;
  merchantName: string | null;
};

/**
 * Builds the deterministic content key used to deduplicate rows the
 * source gave no reference number for.
 *
 * The `occurrence` ordinal is what makes this correct rather than merely
 * plausible: two genuinely separate purchases on the same day, at the
 * same merchant, for the same amount (two identical coffees) share every
 * content field, so a pure content hash would silently discard the
 * second one as a "duplicate" and understate the user's spending.
 * Numbering repeats within one ingestion batch keeps them distinct,
 * while re-ingesting the exact same batch reproduces the same ordinals —
 * so a true re-import/re-sync still deduplicates perfectly.
 */
export function buildDedupeKeySource(row: DedupeableRow, occurrence: number): string {
  return [row.occurredAt.toISOString().slice(0, 10), String(row.amountAgorot), row.description, row.merchantName ?? "", `#${occurrence}`].join(
    "|",
  );
}

/**
 * Assigns a stable `dedupeKeySource` to every row in one ingestion
 * batch, tracking occurrence counts across the WHOLE batch (not
 * per-row) — the same two-pass shape `parseStatementCsv` always used,
 * now shared.
 */
export function assignDedupeKeys<T extends DedupeableRow>(rows: readonly T[]): (T & { dedupeKeySource: string })[] {
  const occurrencesSeen = new Map<string, number>();
  return rows.map((row) => {
    const baseKey = buildDedupeKeySource(row, 0);
    const occurrence = occurrencesSeen.get(baseKey) ?? 0;
    occurrencesSeen.set(baseKey, occurrence + 1);
    return { ...row, dedupeKeySource: buildDedupeKeySource(row, occurrence) };
  });
}

/**
 * Builds the value stored in `NotableTransaction.providerTransactionId`,
 * which the schema's `@@unique([userId, providerTransactionId])` turns
 * into the actual replay guard.
 *
 * Namespaced by `source` + `sourceId` (e.g. `("csv", adapterId)` or
 * `("psd2", institutionId)`) so a bank's own reference `"12345"` can
 * never collide with an unrelated content hash that happens to be
 * `"12345"`, and so two DIFFERENT ingestion sources can never collide
 * with each other either — deliberately NOT unified across sources
 * (a CSV-imported row and a PSD2-synced row for what might be the exact
 * same real-world transaction get DIFFERENT provider ids, and therefore
 * both get inserted) — see `sync-service.ts`'s own doc comment for why
 * true cross-source content unification is a stated, deliberate
 * non-goal here, not an oversight.
 *
 * The content-hash branch is the "content-hash fallback" docs/SECURITY.md
 * §3.3 calls for: without it, rows the source supplies no reference
 * number for would each get `providerTransactionId = null`, and Postgres
 * does **not** treat NULLs as equal in a unique index — so every
 * re-ingestion would insert a full duplicate set of rows with no
 * constraint violation at all. That's the exact "re-importing/re-syncing
 * inflates balances" failure the guard exists to prevent, and it fails
 * silently, which is why the fallback is mandatory rather than a nicety.
 */
export function buildProviderTransactionId(
  row: { providerReference: string | null; dedupeKeySource: string },
  source: string,
  sourceId: string,
): string {
  if (row.providerReference) {
    return `${source}:${sourceId}:ref:${row.providerReference}`;
  }
  const digest = createHash("sha256").update(row.dedupeKeySource).digest("hex").slice(0, 32);
  return `${source}:${sourceId}:hash:${digest}`;
}
