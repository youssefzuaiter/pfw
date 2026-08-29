import { parseShekelsToAgorot, type Agorot } from "./money";
import { containsWholeWord } from "./text-matching";

/**
 * Structured data extraction from raw OCR text (AGENTS.md §3q) — a pure
 * regex/heuristics layer, same `src/lib/` convention as every other
 * engine (§3b): takes a string (whatever `src/lib/receipt-ocr.ts`'s
 * browser-only Tesseract.js wrapper produced), returns structured data,
 * and never touches the DOM, a file, or the network — which is what
 * makes it fully testable with plain OCR-shaped text literals and no
 * browser at all.
 *
 * Every extracted keyword search goes through `text-matching.ts`'s
 * whole-word matching, never a hand-rolled `\b` regex — law #4's Hebrew
 * `\b`-boundary bug applies exactly as much to a Hebrew-language receipt
 * ("סה\"כ" for "total") as it does to a merchant name.
 */

export type ParsedLineItem = { description: string; amountAgorot: Agorot };

export type ParsedReceipt = {
  merchantName: string | null;
  /** The purchase date printed on the receipt, or null if none was confidently found. */
  occurredAt: Date | null;
  /** Positive magnitude, exactly as printed — negating it into an expense is the caller's job (every receipt is an expense; the parser doesn't assume that on its own). */
  totalAgorot: Agorot | null;
  taxAgorot: Agorot | null;
  lineItems: readonly ParsedLineItem[];
};

const TOTAL_KEYWORDS = ["total", "grand total", "amount due", "balance due", "sum", 'סה"כ', "לתשלום"];
const SUBTOTAL_KEYWORDS = ["subtotal", "sub-total", "sub total"];
const TAX_KEYWORDS = ["tax", "vat", "gst", 'מע"מ', "maam"];

/** Requires exactly a 2-digit fraction (`\d+\.\d{2}`), the near-universal way a
 * price is printed — this alone screens out quantities, phone numbers, and
 * other bare integers without needing any currency symbol to be present. */
const CURRENCY_AMOUNT_PATTERN = /\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2}/g;

function splitLines(rawText: string): string[] {
  return rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Every currency-like number on a line, parsed via `money.ts`'s own authoritative
 * parser rather than a second ad hoc float conversion — "money is never a float"
 * applies just as much to a number lifted out of noisy OCR text as anywhere else. */
function findAmountsOnLine(line: string): Agorot[] {
  const matches = line.match(CURRENCY_AMOUNT_PATTERN) ?? [];
  const amounts: Agorot[] = [];
  for (const match of matches) {
    try {
      amounts.push(parseShekelsToAgorot(match));
    } catch {
      // A match that CURRENCY_AMOUNT_PATTERN accepted but parseShekelsToAgorot
      // rejects (this shouldn't happen given the pattern's shape, but the
      // parser is the authority, not this regex) — skip rather than throw,
      // since one malformed OCR token must not fail the whole receipt.
    }
  }
  return amounts;
}

/**
 * The first line that plausibly names a business — not a date, not a
 * pure amount/phone-number-looking line, and containing at least a
 * couple of letters. Receipts consistently print the merchant name in
 * the first line or two, before any address/date/item lines.
 */
export function extractMerchantName(lines: readonly string[]): string | null {
  const candidateLimit = Math.min(lines.length, 5);
  for (let i = 0; i < candidateLimit; i++) {
    const line = lines[i];
    const letterCount = (line.match(/\p{L}/gu) ?? []).length;
    const looksLikeDate = /\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}/.test(line);
    const looksLikePureNumberOrPhone = /^[\d\s()+\-.]+$/.test(line);
    if (letterCount >= 2 && !looksLikeDate && !looksLikePureNumberOrPhone) {
      return line;
    }
  }
  return null;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

function normalizeYear(year: number): number {
  return year < 100 ? 2000 + year : year;
}

/**
 * Finds the first confident date in the text. Numeric `A/B/C` dates are
 * read as day-first (DD/MM/YYYY) unless the first number can't possibly
 * be a day (>12), in which case it's read as MM/DD/YYYY — a reasonable
 * default for a receipt in this app's Israeli context, not a universal
 * rule, and documented as a real ambiguity rather than a silently
 * guessed certainty.
 */
export function extractDate(rawText: string): Date | null {
  const isoMatch = rawText.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    if (isValidCalendarDate(date, Number(y), Number(m), Number(d))) return date;
  }

  const monthNamePattern = /\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{2,4})\b|\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})\b/;
  const monthNameMatch = rawText.match(monthNamePattern);
  if (monthNameMatch) {
    const [, dayA, monthA, yearA, monthB, dayB, yearB] = monthNameMatch;
    const day = Number(dayA ?? dayB);
    const monthKey = (monthA ?? monthB).toLowerCase();
    const year = normalizeYear(Number(yearA ?? yearB));
    const month = MONTH_NAMES[monthKey];
    if (month !== undefined) {
      const date = new Date(Date.UTC(year, month, day));
      if (isValidCalendarDate(date, year, month + 1, day)) return date;
    }
  }

  const numericMatch = rawText.match(/\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})\b/);
  if (numericMatch) {
    const [, a, b, yearRaw] = numericMatch;
    const first = Number(a);
    const second = Number(b);
    const year = normalizeYear(Number(yearRaw));

    // Default to day-first (DD/MM), this app's Israeli context — but only
    // when that's actually possible. If `second` can't be a month
    // (>12), the only valid reading left is MM/DD, so flip. A `first`
    // >12 needs no special case: it simply can't be a month either way,
    // which day-first already handles correctly (first stays the day).
    const isDayFirst = second <= 12;
    const resolvedDay = isDayFirst ? first : second;
    const resolvedMonth = isDayFirst ? second : first;

    const date = new Date(Date.UTC(year, resolvedMonth - 1, resolvedDay));
    if (isValidCalendarDate(date, year, resolvedMonth, resolvedDay)) return date;
  }

  return null;
}

function isValidCalendarDate(date: Date, year: number, month: number, day: number): boolean {
  return (
    !Number.isNaN(date.getTime()) &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * True when `line` names one of `keywords` as a whole word, and none of
 * `excludeKeywords` as a whole word. Whole-word only, deliberately never
 * a plain substring check: "tax" as a substring would false-positive on
 * "Taxi", and Hebrew-safety (law #4) rules out a hand-rolled `\b` regex
 * for the same reason `text-matching.ts` exists at all.
 */
function lineMatchesKeyword(line: string, keywords: readonly string[], excludeKeywords: readonly string[] = []): boolean {
  if (excludeKeywords.some((excluded) => containsWholeWord(line, excluded))) return false;
  return keywords.some((keyword) => containsWholeWord(line, keyword));
}

function extractKeywordAmount(
  lines: readonly string[],
  keywords: readonly string[],
  excludeKeywords: readonly string[] = [],
): Agorot | null {
  for (const line of lines) {
    if (!lineMatchesKeyword(line, keywords, excludeKeywords)) continue;
    const amounts = findAmountsOnLine(line);
    if (amounts.length > 0) return amounts[amounts.length - 1];
  }
  return null;
}

/**
 * The total, if a "total"-labeled line has a parseable amount; otherwise
 * the largest currency-like number anywhere in the receipt — the total
 * is almost always the largest single figure printed, larger than any
 * individual line item.
 */
function extractTotal(lines: readonly string[]): Agorot | null {
  const labeled = extractKeywordAmount(lines, TOTAL_KEYWORDS, SUBTOTAL_KEYWORDS);
  if (labeled !== null) return labeled;

  const allAmounts = lines.flatMap((line) => findAmountsOnLine(line));
  if (allAmounts.length === 0) return null;
  return allAmounts.reduce((max, current) => (current > max ? current : max));
}

function extractTax(lines: readonly string[]): Agorot | null {
  return extractKeywordAmount(lines, TAX_KEYWORDS);
}

/**
 * Best-effort line items: any line with exactly one currency-like amount
 * that isn't the total/subtotal/tax line itself. Genuinely lower-
 * confidence than the other fields — receipts vary wildly in item-line
 * layout — surfaced to the review UI as a convenience, never required
 * for creating the transaction.
 */
function extractLineItems(lines: readonly string[]): ParsedLineItem[] {
  const items: ParsedLineItem[] = [];
  for (const line of lines) {
    if (lineMatchesKeyword(line, [...TOTAL_KEYWORDS, ...SUBTOTAL_KEYWORDS, ...TAX_KEYWORDS])) continue;
    const amounts = findAmountsOnLine(line);
    if (amounts.length !== 1) continue;
    const description = line.replace(CURRENCY_AMOUNT_PATTERN, "").trim();
    if (description.length < 2) continue;
    items.push({ description, amountAgorot: amounts[0] });
  }
  return items;
}

export function parseReceiptText(rawText: string): ParsedReceipt {
  const lines = splitLines(rawText);

  return {
    merchantName: extractMerchantName(lines),
    occurredAt: extractDate(rawText),
    totalAgorot: extractTotal(lines),
    taxAgorot: extractTax(lines),
    lineItems: extractLineItems(lines),
  };
}
