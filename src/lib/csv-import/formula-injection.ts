/**
 * CSV formula-injection neutralization (spec Section 2.4, and
 * docs/SECURITY.md §3.3).
 *
 * The threat: a spreadsheet application treats a cell beginning with
 * `=`, `+`, `-`, or `@` as a formula, not text. A merchant name of
 * `=HYPERLINK("http://evil","Click")` sitting in an imported statement
 * does nothing inside this app (React escapes it, and it's stored as an
 * ordinary string) — but the moment the user exports their ledger and
 * opens it in Excel/Sheets/LibreOffice, it executes. Prefixing a single
 * quote forces the cell to be read as text.
 *
 * **The trap this module exists to avoid:** applying the guard to
 * *every* cell corrupts money. A legitimate debit amount is written
 * `-125.50`, which starts with `-` — neutralizing it to `'-125.50` makes
 * it unparseable as a number, so a naive "sanitize all cells" pass turns
 * every expense in the file into either an error or, worse, a silently
 * mis-signed amount. The guard is therefore applied ONLY to free-text
 * fields that are stored and later re-exported as strings
 * (description, merchant name). Numeric and date fields are deliberately
 * exempt: they never survive as text at all — they're parsed into an
 * integer `Agorot` and a `Date` respectively, and a parsed integer
 * cannot carry a formula. See adapters.ts, where this asymmetry is
 * applied.
 */

/**
 * The four characters the spec names, plus tab and carriage return.
 * OWASP's CSV-injection guidance lists the latter two as well: some
 * spreadsheet applications strip leading whitespace before evaluating
 * the cell, so `\t=cmd` reaches the formula parser as `=cmd` and a
 * four-character check alone would miss it.
 */
const FORMULA_TRIGGER_CHARS = new Set(["=", "+", "-", "@", "\t", "\r"]);

/**
 * Prefixes a leading formula-trigger character with a single quote.
 * Idempotent in the sense that matters: an already-neutralized value
 * starts with `'`, which is not itself a trigger, so re-running this
 * never double-prefixes.
 *
 * Apply to free text only — never to a cell that will be parsed as a
 * number or a date. See this module's header for why.
 */
export function neutralizeFormulaInjection(value: string): string {
  if (value.length === 0) return value;
  return FORMULA_TRIGGER_CHARS.has(value[0]) ? `'${value}` : value;
}

/** Whether a value would be altered by neutralization — used by tests and by the export path to assert the guard is actually reached. */
export function isFormulaInjectionRisk(value: string): boolean {
  return value.length > 0 && FORMULA_TRIGGER_CHARS.has(value[0]);
}
