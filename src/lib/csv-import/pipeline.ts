import { BASE_CURRENCY, type CurrencyCode } from "../currency";
import {
  adapterAcceptsCurrency,
  applyAdapter,
  findStatementHeader,
  getAdapterById,
  type BankAdapter,
} from "./adapters";
import {
  CsvParseError,
  decodeCsvBytes,
  sniffDelimiter,
  tokenizeCsv,
  type CsvParseLimits,
  DEFAULT_CSV_LIMITS,
} from "./csv-parse";
import type { CanonicalImportRow, ImportParseResult } from "./types";
import { assignDedupeKeys } from "../transaction-dedupe";

export { CsvParseError } from "./csv-parse";

/** How many of the file's own rows to quote back when nothing matched. */
const ERROR_SAMPLE_ROWS = 12;
/**
 * Each quoted row is cut to this many characters.
 *
 * Enough rows to reach past a statement's header block, but each one
 * short enough that the user is not pasting a full IBAN or address to
 * ask for help — the column STRUCTURE is what diagnoses this, not the
 * contents.
 */
const ERROR_SAMPLE_ROW_CHARS = 110;

export class UnrecognizedFormatError extends Error {
  readonly code = "unrecognized_format";
  readonly headers: string[];

  /**
   * Quotes the file's own first rows back at the user.
   *
   * Without this the message is unactionable — a real QNB export failed
   * here and neither the user nor the person who wrote the adapters could
   * tell whether the columns were named something unexpected, the header
   * sat below a letterhead, or the text layer came out garbled. The rows
   * are the user's own statement, rendered only in their own browser, so
   * showing them discloses nothing they cannot already see.
   */
  constructor(
    table: readonly string[][],
    readonly currency: CurrencyCode = BASE_CURRENCY,
  ) {
    const sample = table
      .slice(0, ERROR_SAMPLE_ROWS)
      .map((row, index) => {
        const text = row.filter((cell) => cell !== "").join(" | ");
        const clipped =
          text.length > ERROR_SAMPLE_ROW_CHARS ? `${text.slice(0, ERROR_SAMPLE_ROW_CHARS)}…` : text;
        return `  ${index + 1}. ${clipped}`;
      })
      .join("\n");

    super(
      `Could not recognize this file's columns for this ${currency} account. Supported layouts: a generic Date/Description/Amount export, an Israeli bank export with debit & credit columns, an Israeli credit-card export, or a Turkish bank export (Tarih/Açıklama with Borç/Alacak or Tutar).\n\nThe first rows read from this file were:\n${sample}`,
    );
    this.name = "UnrecognizedFormatError";
    this.headers = table[0] ? [...table[0]] : [];
  }
}

/**
 * A caller forced an adapter (by id) whose declared currency isn't the
 * target account's. Automatic detection can never produce this — it skips
 * such adapters — so it only ever means an explicit, wrong choice, which
 * is worth a distinct 400 rather than a generic "unrecognized format".
 */
export class CurrencyMismatchError extends Error {
  readonly code = "currency_mismatch";
  constructor(
    readonly adapterId: string,
    readonly adapterCurrency: CurrencyCode,
    readonly expectedCurrency: CurrencyCode,
  ) {
    super(`The "${adapterId}" layout is for ${adapterCurrency} statements, but this account is in ${expectedCurrency}.`);
    this.name = "CurrencyMismatchError";
  }
}

export type ParseStatementOptions = {
  /** Force a specific adapter instead of detecting one from the header row. */
  adapterId?: string;
  /**
   * The currency of the account the rows are destined for. Every parsed
   * amount is in this currency's minor units; a row whose currency cell
   * says otherwise is rejected per row. Defaults to ILS, which is what
   * every caller before multi-currency import implicitly assumed.
   */
  expectedCurrency?: CurrencyCode;
  limits?: CsvParseLimits;
};

/**
 * The full untrusted-input pipeline, in the order docs/SECURITY.md §3.3
 * specifies: byte-size guard → decode (strict UTF-8, legacy fallback) →
 * delimiter sniff → tokenize (with row/field ceilings) → adapter
 * detection (currency-aware) → per-row validation, currency check, and
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
  const expectedCurrency = options.expectedCurrency ?? BASE_CURRENCY;
  const text = decodeCsvBytes(bytes, limits, expectedCurrency);
  // The delimiter is decided from the first physical line BEFORE any
  // tokenizing — see sniffDelimiter for why the order matters.
  const table = tokenizeCsv(text, limits, sniffDelimiter(text));

  let forced: BankAdapter | undefined;
  if (options.adapterId) {
    const chosen = getAdapterById(options.adapterId);
    if (!chosen) throw new UnrecognizedFormatError(table, expectedCurrency);
    if (!adapterAcceptsCurrency(chosen, expectedCurrency)) {
      // `adapterAcceptsCurrency` is false only when a currency is declared.
      throw new CurrencyMismatchError(chosen.id, chosen.currency as CurrencyCode, expectedCurrency);
    }
    forced = chosen;
  }

  // The header is NOT necessarily row 0 — a PDF statement opens with a
  // letterhead and account details. See findStatementHeader.
  const located = findStatementHeader(table, expectedCurrency, forced);
  if (!located) throw new UnrecognizedFormatError(table, expectedCurrency);

  const { index, adapter } = located;
  const headers = table[index];

  // A multi-page statement repeats its column header on every page.
  // Those rows are not transactions — left in, each one becomes a row
  // whose date cell says "İşlem Tarihi" and therefore a RowError, so a
  // 5-page statement would report 4 rejected rows that are not problems
  // with the user's data at all.
  const headerKey = headers.join("\u0000");
  const records = table.slice(index + 1).filter((row) => row.join("\u0000") !== headerKey);

  const { rows: parsedRows, errors } = applyAdapter(adapter, headers, records, expectedCurrency);
  const rows: CanonicalImportRow[] = assignDedupeKeys(parsedRows);

  return { adapterId: adapter.id, adapterLabel: adapter.label, currency: expectedCurrency, rows, errors };
}

/** Narrow type guard so route handlers can distinguish "bad file" (400) from an unexpected server fault (500). */
export function isClientFileError(
  error: unknown,
): error is CsvParseError | UnrecognizedFormatError | CurrencyMismatchError {
  return (
    error instanceof CsvParseError || error instanceof UnrecognizedFormatError || error instanceof CurrencyMismatchError
  );
}
