import { applyAdapter, detectAdapter, getAdapterById, type BankAdapter } from "./adapters";
import { CsvParseError, decodeCsvBytes, tokenizeCsv, type CsvParseLimits, DEFAULT_CSV_LIMITS } from "./csv-parse";
import type { CanonicalImportRow, ImportParseResult } from "./types";

export { CsvParseError } from "./csv-parse";

export class UnrecognizedFormatError extends Error {
  readonly code = "unrecognized_format";
  constructor(readonly headers: string[]) {
    super(
      "Could not recognize this file's columns. Supported layouts: a generic Date/Description/Amount export, an Israeli bank export with debit & credit columns, or a credit-card export.",
    );
    this.name = "UnrecognizedFormatError";
  }
}

/**
 * Builds the deterministic content key used to deduplicate rows the bank
 * gave no reference number for.
 *
 * The `occurrence` ordinal is what makes this correct rather than merely
 * plausible: two genuinely separate purchases on the same day, at the
 * same merchant, for the same amount (two identical coffees) share every
 * content field, so a pure content hash would silently discard the
 * second one as a "duplicate" and understate the user's spending.
 * Numbering repeats within the file keeps them distinct, while
 * re-importing the same file reproduces the same ordinals — so a true
 * re-import still deduplicates perfectly.
 */
function buildDedupeKeySource(
  row: Omit<CanonicalImportRow, "dedupeKeySource">,
  occurrence: number,
): string {
  return [
    row.occurredAt.toISOString().slice(0, 10),
    String(row.amountAgorot),
    row.description,
    row.merchantName ?? "",
    `#${occurrence}`,
  ].join("|");
}

export type ParseStatementOptions = {
  /** Force a specific adapter instead of detecting one from the header row. */
  adapterId?: string;
  limits?: CsvParseLimits;
};

/**
 * The full untrusted-input pipeline, in the order docs/SECURITY.md §3.3
 * specifies: byte-size guard → tokenize (with row/field ceilings) →
 * adapter detection → per-row validation, currency check, and
 * formula-injection neutralization → canonical rows with stable dedupe
 * keys.
 *
 * Pure: takes bytes, returns data. It never touches the database — the
 * DAL (`src/server/dal/transaction-import.ts`) is what turns these rows
 * into `NotableTransaction` records, which is also what keeps this
 * entire module testable with plain string literals and no Postgres
 * (AGENTS.md §3b's engine/DAL split).
 */
export function parseStatementCsv(bytes: Uint8Array, options: ParseStatementOptions = {}): ImportParseResult {
  const limits = options.limits ?? DEFAULT_CSV_LIMITS;
  const text = decodeCsvBytes(bytes, limits);
  const table = tokenizeCsv(text, limits);

  const [headers, ...records] = table;

  let adapter: BankAdapter | null;
  if (options.adapterId) {
    adapter = getAdapterById(options.adapterId);
    if (!adapter) throw new UnrecognizedFormatError(headers);
  } else {
    adapter = detectAdapter(headers);
    if (!adapter) throw new UnrecognizedFormatError(headers);
  }

  const { rows: parsedRows, errors } = applyAdapter(adapter, headers, records);

  const occurrencesSeen = new Map<string, number>();
  const rows: CanonicalImportRow[] = parsedRows.map((row) => {
    const baseKey = buildDedupeKeySource(row, 0);
    const occurrence = occurrencesSeen.get(baseKey) ?? 0;
    occurrencesSeen.set(baseKey, occurrence + 1);
    return { ...row, dedupeKeySource: buildDedupeKeySource(row, occurrence) };
  });

  return { adapterId: adapter.id, adapterLabel: adapter.label, rows, errors };
}

/** Narrow type guard so route handlers can distinguish "bad file" (400) from an unexpected server fault (500). */
export function isClientFileError(error: unknown): error is CsvParseError | UnrecognizedFormatError {
  return error instanceof CsvParseError || error instanceof UnrecognizedFormatError;
}
