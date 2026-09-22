import { BASE_CURRENCY, type CurrencyCode } from "../currency";
import { adapterAcceptsCurrency, applyAdapter, detectAdapter, getAdapterById, type BankAdapter } from "./adapters";
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

export class UnrecognizedFormatError extends Error {
  readonly code = "unrecognized_format";
  constructor(
    readonly headers: string[],
    readonly currency: CurrencyCode = BASE_CURRENCY,
  ) {
    super(
      `Could not recognize this file's columns for this ${currency} account. Supported layouts: a generic Date/Description/Amount export, an Israeli bank export with debit & credit columns, an Israeli credit-card export, or a Turkish bank export (Tarih/Açıklama with Borç/Alacak or Tutar).`,
    );
    this.name = "UnrecognizedFormatError";
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

  const [headers, ...records] = table;

  let adapter: BankAdapter | null;
  if (options.adapterId) {
    adapter = getAdapterById(options.adapterId);
    if (!adapter) throw new UnrecognizedFormatError(headers, expectedCurrency);
    if (!adapterAcceptsCurrency(adapter, expectedCurrency)) {
      // `adapterAcceptsCurrency` is false only when a currency is declared.
      throw new CurrencyMismatchError(adapter.id, adapter.currency as CurrencyCode, expectedCurrency);
    }
  } else {
    adapter = detectAdapter(headers, expectedCurrency);
    if (!adapter) throw new UnrecognizedFormatError(headers, expectedCurrency);
  }

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
