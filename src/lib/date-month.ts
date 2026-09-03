/**
 * The one canonical `YYYY-MM` month-key format `EnvelopeAllocation.month`
 * (schema.prisma) is stored as — a plain string, not a `DateTime`,
 * specifically to avoid any timezone-boundary ambiguity about which
 * calendar month a given instant belongs to. Every place that produces
 * or validates a month key (the DAL's ledger math, the allocate API
 * route's Zod schema, the budgets UI) goes through this module rather
 * than re-deriving the format independently.
 */

const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidMonthKey(value: string): boolean {
  return MONTH_KEY_PATTERN.test(value);
}

/** UTC-anchored, matching `prisma/seed/rng.ts`'s own `monthKeyFor` — not importable from there (that file lives outside `src/`), so this is the app-runtime sibling of the same idea. */
export function monthKeyFor(date: Date): string {
  return date.toISOString().slice(0, 7);
}

export function currentMonthKey(): string {
  return monthKeyFor(new Date());
}

/**
 * `YYYY-MM` strings compare correctly with plain string comparison
 * (`<=`, `<`, etc.) — this wrapper exists only so call sites read as
 * "compare these two months" rather than leaving that fact implicit.
 * Returns -1/0/1 like `Array.prototype.sort`'s comparator convention.
 */
export function compareMonthKeys(a: string, b: string): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** The first instant (UTC) of the given `YYYY-MM` month — an inclusive lower bound for a `DateTime` range query. */
export function monthKeyToStartDate(monthKey: string): Date {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1));
}

/** The first instant (UTC) of the month AFTER the given `YYYY-MM` — an exclusive upper bound for "every `DateTime` up to and including this month". */
export function monthKeyToExclusiveEndDate(monthKey: string): Date {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(year, month, 1));
}
