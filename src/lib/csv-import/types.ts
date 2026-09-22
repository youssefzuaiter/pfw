import type { CurrencyCode, NativeAmount } from "../currency";

/** A single successfully-parsed statement line, in this app's canonical shape. */
export type CanonicalImportRow = {
  /** 1-based line number in the source file (header counts as line 1) — every row error quotes this so a user can find the offending line. */
  lineNumber: number;
  occurredAt: Date;
  /**
   * Signed, in the statement's own currency's minor units (agorot, kuruş,
   * cents…): negative = money out, positive = money in. Normalized by the
   * adapter from whatever sign convention the bank used. Deliberately the
   * NATIVE figure, not an ILS conversion: the pipeline is pure and has no
   * exchange rate to convert with — the DAL freezes the rate at write time
   * (`transaction-import.ts`), and the dedupe key below is built from this
   * native amount so re-importing the same file on a day with a different
   * rate still produces identical keys.
   */
  nativeAmount: NativeAmount;
  /** The currency every `nativeAmount` in this parse is denominated in — always the target account's, enforced by the pipeline. */
  currency: CurrencyCode;
  /** Free text, already formula-injection-neutralized. */
  description: string;
  /** Free text, already formula-injection-neutralized. `null` when the export has no distinct merchant column. */
  merchantName: string | null;
  /**
   * The bank's own transaction reference, when the export provides one.
   * `null` falls back to content-based deduplication — see `dedupeKeySource`.
   */
  providerReference: string | null;
  /**
   * A deterministic string identifying this row's content, used to build
   * a stable dedupe key when the bank supplies no reference of its own.
   * Includes an occurrence ordinal so two genuinely distinct but
   * identical-looking transactions (same day, same amount, same merchant
   * — e.g. two identical coffees) don't collapse into one, while
   * re-importing the same file still produces the same keys. See
   * pipeline.ts.
   */
  dedupeKeySource: string;
};

/** A row that could not be parsed. Non-fatal: the import continues and reports these alongside what succeeded. */
export type RowError = {
  lineNumber: number;
  message: string;
};

export type ImportParseResult = {
  adapterId: string;
  adapterLabel: string;
  /** The currency the rows were parsed as — the target account's. */
  currency: CurrencyCode;
  rows: CanonicalImportRow[];
  errors: RowError[];
};
