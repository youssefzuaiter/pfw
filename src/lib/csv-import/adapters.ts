import {
  BASE_CURRENCY,
  nativeAmount as toNativeAmount,
  parseDecimalToNativeAmount,
  type CurrencyCode,
  type NativeAmount,
} from "../currency";
import { neutralizeFormulaInjection } from "./formula-injection";
import type { CanonicalImportRow, RowError } from "./types";

/**
 * One adapter per institution (AGENTS.md §5, decision #4). Each adapter
 * declares *only* its column names, date format, sign convention, number
 * format and (optionally) currency; all the actual parsing logic is
 * shared below. That's the point of the split: a wrong column alias for
 * one bank can't corrupt another bank's parsing, but there's exactly one
 * implementation of "how do we turn an amount string into minor units"
 * to get right and to test.
 *
 * **Honest scope note:** these layouts are *representative* of the shapes
 * bank and credit-card exports commonly take (separate debit/credit
 * columns, DD/MM/YYYY dates, Hebrew or Turkish headers) and match this
 * app's mock data. They are not byte-verified reproductions of any real
 * institution's current export format — adding a real one means checking
 * a real export's headers and adding an entry here, not restructuring
 * anything. The two Turkish adapters in particular were written without
 * a sample file (AGENTS.md §3bbb), which is why the import UI previews
 * parsed rows before committing anything.
 */

type DateFormat = "DD/MM/YYYY" | "YYYY-MM-DD";

/**
 * How the bank encodes direction of money movement:
 * - `signed`: one amount column, already negative for money out.
 * - `debit-credit`: two columns; whichever is populated decides the sign.
 * - `expense-positive`: one amount column where a positive number means a
 *   charge (money out) — the usual credit-card-statement convention.
 *   Getting this wrong silently inverts every amount in the file, which
 *   is why it's declared per adapter rather than guessed from the data.
 */
type AmountConvention = "signed" | "debit-credit" | "expense-positive";

/**
 * How the bank writes a number: `dot-decimal` is `1,234.56`; `comma-decimal`
 * is `1.234,56` (Turkish, most of continental Europe). Declared, never
 * sniffed, and enforced as a strict grammar in `normalizeAmountText` —
 * naively swapping separators would read a `1234.56` that slipped into a
 * comma-decimal file as `123456`, a silent 100× error.
 */
export type NumberFormat = "dot-decimal" | "comma-decimal";

type ColumnAliases = {
  date: readonly string[];
  description: readonly string[];
  merchant?: readonly string[];
  reference?: readonly string[];
  amount?: readonly string[];
  debit?: readonly string[];
  credit?: readonly string[];
  currency?: readonly string[];
};

export type BankAdapter = {
  id: string;
  label: string;
  dateFormat: DateFormat;
  amountConvention: AmountConvention;
  /** Defaults to `dot-decimal`. */
  numberFormat?: NumberFormat;
  /**
   * The currency this layout's amounts are known to be in, when the
   * layout itself implies one (an Israeli bank's export is in shekels; a
   * Turkish bank's in lira). `detectAdapter` skips an adapter whose
   * declared currency differs from the target account's, so an
   * English-header Turkish export into a TRY account can't be captured by
   * an ILS adapter's English aliases. Left unset for a genuinely generic
   * layout, which then simply parses in whatever currency the account is.
   */
  currency?: CurrencyCode;
  columns: ColumnAliases;
};

export const BANK_ADAPTERS: readonly BankAdapter[] = [
  {
    id: "generic",
    label: "Generic (Date, Description, Amount)",
    dateFormat: "YYYY-MM-DD",
    amountConvention: "signed",
    columns: {
      date: ["date", "transaction date", "posted date"],
      description: ["description", "details", "memo", "narrative"],
      merchant: ["merchant", "payee", "merchant name"],
      reference: ["reference", "transaction id", "id", "reference number"],
      amount: ["amount", "value"],
      currency: ["currency", "ccy"],
    },
  },
  {
    id: "leumi",
    label: "Bank Leumi / Hapoalim style (debit & credit columns)",
    dateFormat: "DD/MM/YYYY",
    amountConvention: "debit-credit",
    currency: "ILS",
    columns: {
      date: ["תאריך", "date", "תאריך ערך"],
      description: ["תיאור", "פרטים", "description", "details"],
      merchant: ["בית עסק", "merchant"],
      reference: ["אסמכתא", "reference", "מספר אסמכתא"],
      debit: ["חובה", "debit", "חיוב"],
      credit: ["זכות", "credit", "זיכוי"],
      currency: ["מטבע", "currency"],
    },
  },
  {
    id: "isracard",
    label: "Isracard / credit card style (charges positive)",
    dateFormat: "DD/MM/YYYY",
    amountConvention: "expense-positive",
    currency: "ILS",
    columns: {
      date: ["תאריך עסקה", "תאריך", "date", "transaction date"],
      description: ["שם בית העסק", "בית עסק", "description", "merchant"],
      merchant: ["שם בית העסק", "בית עסק", "merchant"],
      reference: ["מספר שובר", "אסמכתא", "reference"],
      amount: ["סכום חיוב", "סכום", "amount", "charge"],
      currency: ["מטבע", "currency"],
    },
  },
  // Turkish bank exports (AGENTS.md §3bbb). Aliases are written as they
  // appear in the exports and matched after Turkish-aware folding (see
  // normalizeHeader), so `İşlem Tarihi`, `islem tarihi` and `İŞLEM TARİHİ`
  // all resolve. Deliberately NO reference aliases: a Turkish slip number
  // (fiş no / dekont no) restarts per account, and providerTransactionId
  // is unique per USER, so two TRY accounts at one bank would collide on
  // the `:ref:` path — the content-hash path is the safe key here. And
  // only `para birimi` for currency: a card statement's `döviz cinsi`
  // names the ORIGINAL foreign currency of a purchase that was billed in
  // lira, which would falsely reject the row.
  {
    id: "turkish-debit-credit",
    label: "Turkish bank statement (Tarih / Açıklama / Borç / Alacak)",
    dateFormat: "DD/MM/YYYY",
    amountConvention: "debit-credit",
    numberFormat: "comma-decimal",
    currency: "TRY",
    columns: {
      date: ["tarih", "işlem tarihi", "date", "transaction date"],
      description: ["açıklama", "işlem açıklaması", "description", "details"],
      debit: ["borç", "çıkan", "debit"],
      credit: ["alacak", "giren", "credit"],
      currency: ["para birimi", "currency"],
    },
  },
  {
    id: "turkish-signed-amount",
    label: "Turkish bank / card statement (Tarih / Açıklama / Tutar)",
    dateFormat: "DD/MM/YYYY",
    amountConvention: "signed",
    numberFormat: "comma-decimal",
    currency: "TRY",
    columns: {
      date: ["tarih", "işlem tarihi", "date", "transaction date"],
      description: ["açıklama", "işlem açıklaması", "description", "details"],
      amount: ["tutar", "işlem tutarı", "amount"],
      currency: ["para birimi", "currency"],
    },
  },
];

/**
 * How a statement may spell each currency in a currency column or inline
 * in an amount cell. A row's currency cell must resolve to the target
 * account's currency; anything else is refused per row, never converted
 * — the pipeline has no exchange rate, and importing a USD row as though
 * it were lira (or shekels) would corrupt the ledger by the FX rate.
 */
const CURRENCY_TOKENS: Record<CurrencyCode, readonly string[]> = {
  ILS: ["ils", "nis", "₪", "shekel", "shekels"],
  TRY: ["try", "tl", "₺", "lira"],
  USD: ["usd", "$"],
  EUR: ["eur", "€"],
  GBP: ["gbp", "£"],
};

/**
 * Folds a header (or an alias) to a comparable form. Beyond trim/lowercase/
 * whitespace-collapse, this maps Turkish's two dotted/dotless `i`s to
 * plain ASCII and strips every combining mark — `"İ".toLowerCase()` is
 * `"i̇"` (an `i` plus U+0307), which would never equal an ASCII `i`, and a
 * Turkish keyboard's `ı` isn't `i` at all. Hebrew letters carry no
 * combining marks in any bank header, so the Hebrew aliases are
 * unaffected (asserted in the tests).
 */
export function normalizeHeader(header: string): string {
  return header
    .replace(/İ/g, "I")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Resolves each declared alias to a column index in the actual header row. */
function resolveColumns(headers: string[], aliases: readonly string[] | undefined): number {
  if (!aliases) return -1;
  const normalized = headers.map(normalizeHeader);
  for (const alias of aliases) {
    const index = normalized.indexOf(normalizeHeader(alias));
    if (index !== -1) return index;
  }
  return -1;
}

type ResolvedColumns = {
  date: number;
  description: number;
  merchant: number;
  reference: number;
  amount: number;
  debit: number;
  credit: number;
  currency: number;
};

function resolveAdapterColumns(adapter: BankAdapter, headers: string[]): ResolvedColumns {
  return {
    date: resolveColumns(headers, adapter.columns.date),
    description: resolveColumns(headers, adapter.columns.description),
    merchant: resolveColumns(headers, adapter.columns.merchant),
    reference: resolveColumns(headers, adapter.columns.reference),
    amount: resolveColumns(headers, adapter.columns.amount),
    debit: resolveColumns(headers, adapter.columns.debit),
    credit: resolveColumns(headers, adapter.columns.credit),
    currency: resolveColumns(headers, adapter.columns.currency),
  };
}

/** An adapter matches only if every column it structurally requires is present. */
function adapterMatches(adapter: BankAdapter, headers: string[]): boolean {
  const resolved = resolveAdapterColumns(adapter, headers);
  if (resolved.date === -1 || resolved.description === -1) return false;

  if (adapter.amountConvention === "debit-credit") {
    return resolved.debit !== -1 && resolved.credit !== -1;
  }
  return resolved.amount !== -1;
}

/** Whether an adapter may be used for an account in `currency` — an adapter with no declared currency may be used for any. */
export function adapterAcceptsCurrency(adapter: BankAdapter, currency: CurrencyCode): boolean {
  return adapter.currency === undefined || adapter.currency === currency;
}

/**
 * Picks the first adapter whose declared columns are all present in the
 * header row AND whose declared currency (if any) is the target
 * account's. Deliberately returns `null` rather than falling back to a
 * best-guess adapter: mis-detecting a format silently mis-signs or
 * mis-dates every row in the file, which is far worse than refusing the
 * upload and telling the user which formats are supported.
 */
export function detectAdapter(headers: string[], expectedCurrency: CurrencyCode = BASE_CURRENCY): BankAdapter | null {
  return (
    BANK_ADAPTERS.find((adapter) => adapterAcceptsCurrency(adapter, expectedCurrency) && adapterMatches(adapter, headers)) ??
    null
  );
}

export function getAdapterById(id: string): BankAdapter | null {
  return BANK_ADAPTERS.find((adapter) => adapter.id === id) ?? null;
}

const COMMA_DECIMAL_PATTERN = /^\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?$|^\d+(?:,\d{1,2})?$/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Normalizes the sign conventions a raw amount cell can carry, strips the
 * currency's own inline tokens, and — for a comma-decimal layout —
 * rewrites the number into the dot-decimal grammar `parseDecimalToNativeAmount`
 * accepts. Handles accounting-style parentheses — `(125.50)` — and the
 * trailing-minus style — `125.50-` — both of which appear in real exports
 * and would otherwise be rejected outright (or, with parentheses, be
 * silently read as a *positive* number if the punctuation were merely
 * stripped).
 *
 * The comma-decimal rewrite is a strict grammar, not a separator swap:
 * `1.234,56` and `1234,56` and `1.234` are accepted, `1234.56` is
 * rejected as malformed rather than read as 123456.
 */
export function normalizeAmountText(
  raw: string,
  currency: CurrencyCode = BASE_CURRENCY,
  numberFormat: NumberFormat = "dot-decimal",
): string {
  let text = raw.trim().replace(/\s+/g, "");
  if (text === "") return text;

  // Strip currency tokens the amount column sometimes carries inline.
  const tokens = CURRENCY_TOKENS[currency].map(escapeRegExp).join("|");
  text = text.replace(new RegExp(tokens, "gi"), "");

  let negative = false;
  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.endsWith("-")) {
    negative = true;
    text = text.slice(0, -1);
  }
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  }
  if (text.startsWith("+")) {
    text = text.slice(1);
  }

  if (text === "") return "";

  if (numberFormat === "comma-decimal") {
    if (!COMMA_DECIMAL_PATTERN.test(text)) {
      throw new Error(`amount "${raw.trim()}" is not a valid comma-decimal number (expected e.g. 1.234,56)`);
    }
    text = text.replace(/\./g, "").replace(",", ".");
  }

  return negative ? `-${text}` : text;
}

function parseAmountCell(raw: string, currency: CurrencyCode, numberFormat: NumberFormat): NativeAmount {
  const normalized = normalizeAmountText(raw, currency, numberFormat);
  if (normalized === "") {
    throw new Error("amount is empty");
  }
  return parseDecimalToNativeAmount(normalized);
}

/**
 * Parses a date in the adapter's *declared* format. Never sniffs the
 * format from the value: `03/04/2026` is a valid date under both
 * DD/MM/YYYY and MM/DD/YYYY and means two different days, so guessing
 * would silently mis-date a third of every year's rows.
 *
 * An optional trailing time-of-day (`01.03.2026 14:23`, common in Turkish
 * exports) is accepted and ignored — `occurredAt` is a calendar day.
 *
 * Builds a UTC date and then verifies the constructed components round
 * -trip, which is what rejects `31/02/2026` — `Date.UTC` would otherwise
 * happily roll it forward to March 3rd.
 */
export function parseStatementDate(raw: string, format: DateFormat): Date {
  const text = raw.trim().replace(/\s+\d{1,2}:\d{2}(?::\d{2})?$/, "");
  if (text === "") throw new Error("date is empty");

  let year: number;
  let month: number;
  let day: number;

  if (format === "YYYY-MM-DD") {
    const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
    if (!match) throw new Error(`date "${text}" is not in YYYY-MM-DD format`);
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    const match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(text);
    if (!match) throw new Error(`date "${text}" is not in DD/MM/YYYY format`);
    day = Number(match[1]);
    month = Number(match[2]);
    year = Number(match[3]);
    // A 2-digit year in a personal finance statement is always this
    // century in practice; anchoring it explicitly beats letting
    // `new Date(26, ...)` resolve to the year 1926.
    if (match[3].length === 2) year += 2000;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  const isRealDate =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  if (!isRealDate) {
    throw new Error(`date "${text}" is not a real calendar date`);
  }
  return date;
}

function cell(record: string[], index: number): string {
  return index === -1 ? "" : (record[index] ?? "").trim();
}

function assertRowCurrency(record: string[], currencyIndex: number, expected: CurrencyCode): void {
  const stated = cell(record, currencyIndex).toLowerCase();
  if (stated === "" || CURRENCY_TOKENS[expected].includes(stated)) return;
  // Refusing is the only safe option: this pipeline has no exchange
  // rate, and importing a USD row into a lira (or shekel) account as
  // though it were that currency would corrupt the ledger by the FX rate.
  throw new Error(`currency "${stated.toUpperCase()}" is not supported for this account (expected ${expected})`);
}

function resolveAmount(
  adapter: BankAdapter,
  record: string[],
  columns: ResolvedColumns,
  currency: CurrencyCode,
): NativeAmount {
  const numberFormat = adapter.numberFormat ?? "dot-decimal";

  if (adapter.amountConvention === "debit-credit") {
    const debitText = normalizeAmountText(cell(record, columns.debit), currency, numberFormat);
    const creditText = normalizeAmountText(cell(record, columns.credit), currency, numberFormat);
    const hasDebit = debitText !== "" && parseDecimalToNativeAmount(debitText) !== 0;
    const hasCredit = creditText !== "" && parseDecimalToNativeAmount(creditText) !== 0;

    if (hasDebit && hasCredit) {
      throw new Error("both debit and credit columns are populated — ambiguous direction");
    }
    if (hasDebit) {
      // Debit = money out. Take the magnitude so a bank that already
      // writes debits as negative doesn't get double-negated into income.
      return toNativeAmount(-Math.abs(parseDecimalToNativeAmount(debitText)));
    }
    if (hasCredit) {
      return toNativeAmount(Math.abs(parseDecimalToNativeAmount(creditText)));
    }
    throw new Error("neither debit nor credit column has an amount");
  }

  const amount = parseAmountCell(cell(record, columns.amount), currency, numberFormat);
  if (adapter.amountConvention === "expense-positive") {
    return toNativeAmount(-amount);
  }
  return amount;
}

export type AdapterParseOutcome = {
  rows: Omit<CanonicalImportRow, "dedupeKeySource">[];
  errors: RowError[];
};

/**
 * Maps tokenized CSV records (header row excluded) into canonical rows
 * using one adapter, every amount in `expectedCurrency`'s minor units. A
 * row that fails to parse is collected as a `RowError` and skipped rather
 * than aborting the whole file — a single malformed line in a 300-line
 * statement shouldn't cost the user the other 299.
 */
export function applyAdapter(
  adapter: BankAdapter,
  headers: string[],
  records: string[][],
  expectedCurrency: CurrencyCode = BASE_CURRENCY,
): AdapterParseOutcome {
  const columns = resolveAdapterColumns(adapter, headers);
  const rows: Omit<CanonicalImportRow, "dedupeKeySource">[] = [];
  const errors: RowError[] = [];

  records.forEach((record, recordIndex) => {
    // +2: the header occupies line 1, and lineNumber is 1-based.
    const lineNumber = recordIndex + 2;
    try {
      assertRowCurrency(record, columns.currency, expectedCurrency);

      const occurredAt = parseStatementDate(cell(record, columns.date), adapter.dateFormat);
      const nativeAmount = resolveAmount(adapter, record, columns, expectedCurrency);

      const rawDescription = cell(record, columns.description);
      const rawMerchant = cell(record, columns.merchant);
      if (rawDescription === "" && rawMerchant === "") {
        throw new Error("row has neither a description nor a merchant name");
      }

      // Formula-injection neutralization applies to these two free-text
      // fields ONLY — never to the amount or date cells above, which are
      // parsed into an integer and a Date and never persist as text. See
      // formula-injection.ts's header for why that distinction is
      // load-bearing rather than an optimization.
      const description = neutralizeFormulaInjection(rawDescription || rawMerchant);
      const merchantName = rawMerchant === "" ? null : neutralizeFormulaInjection(rawMerchant);

      const reference = cell(record, columns.reference);

      rows.push({
        lineNumber,
        occurredAt,
        nativeAmount,
        currency: expectedCurrency,
        description,
        merchantName,
        providerReference: reference === "" ? null : reference,
      });
    } catch (error) {
      errors.push({
        lineNumber,
        message: error instanceof Error ? error.message : "could not parse row",
      });
    }
  });

  return { rows, errors };
}
