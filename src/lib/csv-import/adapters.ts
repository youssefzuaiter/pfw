import { agorot, parseShekelsToAgorot, type Agorot } from "../money";
import { neutralizeFormulaInjection } from "./formula-injection";
import type { CanonicalImportRow, RowError } from "./types";

/**
 * One adapter per institution (AGENTS.md §5, decision #4). Each adapter
 * declares *only* its column names, date format, and sign convention;
 * all the actual parsing logic is shared below. That's the point of the
 * split: a wrong column alias for one bank can't corrupt another bank's
 * parsing, but there's exactly one implementation of "how do we turn a
 * shekel string into agorot" to get right and to test.
 *
 * **Honest scope note:** these layouts are *representative* of the shapes
 * Israeli bank and credit-card exports commonly take (separate
 * debit/credit columns, DD/MM/YYYY dates, Hebrew headers) and match this
 * app's mock data. They are not byte-verified reproductions of any real
 * institution's current export format — adding a real one means checking
 * a real export's headers and adding an entry here, not restructuring
 * anything.
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
    columns: {
      date: ["תאריך עסקה", "תאריך", "date", "transaction date"],
      description: ["שם בית העסק", "בית עסק", "description", "merchant"],
      merchant: ["שם בית העסק", "בית עסק", "merchant"],
      reference: ["מספר שובר", "אסמכתא", "reference"],
      amount: ["סכום חיוב", "סכום", "amount", "charge"],
      currency: ["מטבע", "currency"],
    },
  },
];

/** Only shekel rows are importable — this app is single-currency by law (spec Section 1). */
const ACCEPTED_CURRENCY_TOKENS = new Set(["", "ils", "nis", "₪", "shekel", "shekels"]);

export function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, " ");
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

/**
 * Picks the adapter whose declared columns are all present in the header
 * row. Deliberately returns `null` rather than falling back to a
 * best-guess adapter: mis-detecting a format silently mis-signs or
 * mis-dates every row in the file, which is far worse than refusing the
 * upload and telling the user which formats are supported.
 */
export function detectAdapter(headers: string[]): BankAdapter | null {
  return BANK_ADAPTERS.find((adapter) => adapterMatches(adapter, headers)) ?? null;
}

export function getAdapterById(id: string): BankAdapter | null {
  return BANK_ADAPTERS.find((adapter) => adapter.id === id) ?? null;
}

/**
 * Normalizes the sign conventions a raw amount cell can carry before
 * handing it to `parseShekelsToAgorot`, which accepts only a leading
 * minus. Handles accounting-style parentheses — `(125.50)` — and the
 * trailing-minus style — `125.50-` — both of which appear in real
 * exports and would otherwise be rejected outright (or, with
 * parentheses, be silently read as a *positive* number if the
 * punctuation were merely stripped).
 */
export function normalizeAmountText(raw: string): string {
  let text = raw.trim().replace(/\s+/g, "");
  if (text === "") return text;

  // Strip currency tokens the amount column sometimes carries inline.
  text = text.replace(/₪|ils|nis/gi, "");

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
  return negative ? `-${text}` : text;
}

function parseAmountCell(raw: string): Agorot {
  const normalized = normalizeAmountText(raw);
  if (normalized === "") {
    throw new Error("amount is empty");
  }
  return parseShekelsToAgorot(normalized);
}

/**
 * Parses a date in the adapter's *declared* format. Never sniffs the
 * format from the value: `03/04/2026` is a valid date under both
 * DD/MM/YYYY and MM/DD/YYYY and means two different days, so guessing
 * would silently mis-date a third of every year's rows.
 *
 * Builds a UTC date and then verifies the constructed components round
 * -trip, which is what rejects `31/02/2026` — `Date.UTC` would otherwise
 * happily roll it forward to March 3rd.
 */
export function parseStatementDate(raw: string, format: DateFormat): Date {
  const text = raw.trim();
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

function assertShekelCurrency(record: string[], currencyIndex: number): void {
  const currency = cell(record, currencyIndex).toLowerCase();
  if (!ACCEPTED_CURRENCY_TOKENS.has(currency)) {
    // Refusing is the only safe option: importing a USD row as though it
    // were shekels would corrupt the ledger with a ~3.7x error, and this
    // app has no multi-currency model to convert into (spec Section 1).
    throw new Error(`currency "${currency.toUpperCase()}" is not supported — this ledger is shekel-only`);
  }
}

function resolveAmount(adapter: BankAdapter, record: string[], columns: ResolvedColumns): Agorot {
  if (adapter.amountConvention === "debit-credit") {
    const debitText = normalizeAmountText(cell(record, columns.debit));
    const creditText = normalizeAmountText(cell(record, columns.credit));
    const hasDebit = debitText !== "" && parseShekelsToAgorot(debitText) !== 0;
    const hasCredit = creditText !== "" && parseShekelsToAgorot(creditText) !== 0;

    if (hasDebit && hasCredit) {
      throw new Error("both debit and credit columns are populated — ambiguous direction");
    }
    if (hasDebit) {
      // Debit = money out. Take the magnitude so a bank that already
      // writes debits as negative doesn't get double-negated into income.
      return agorot(-Math.abs(parseShekelsToAgorot(debitText)));
    }
    if (hasCredit) {
      return agorot(Math.abs(parseShekelsToAgorot(creditText)));
    }
    throw new Error("neither debit nor credit column has an amount");
  }

  const amount = parseAmountCell(cell(record, columns.amount));
  if (adapter.amountConvention === "expense-positive") {
    return agorot(-amount);
  }
  return amount;
}

export type AdapterParseOutcome = {
  rows: Omit<CanonicalImportRow, "dedupeKeySource">[];
  errors: RowError[];
};

/**
 * Maps tokenized CSV records (header row excluded) into canonical rows
 * using one adapter. A row that fails to parse is collected as a
 * `RowError` and skipped rather than aborting the whole file — a single
 * malformed line in a 300-line statement shouldn't cost the user the
 * other 299.
 */
export function applyAdapter(adapter: BankAdapter, headers: string[], records: string[][]): AdapterParseOutcome {
  const columns = resolveAdapterColumns(adapter, headers);
  const rows: Omit<CanonicalImportRow, "dedupeKeySource">[] = [];
  const errors: RowError[] = [];

  records.forEach((record, recordIndex) => {
    // +2: the header occupies line 1, and lineNumber is 1-based.
    const lineNumber = recordIndex + 2;
    try {
      assertShekelCurrency(record, columns.currency);

      const occurredAt = parseStatementDate(cell(record, columns.date), adapter.dateFormat);
      const amountAgorot = resolveAmount(adapter, record, columns);

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
        amountAgorot,
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
