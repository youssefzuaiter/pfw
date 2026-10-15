/**
 * Date-aware exchange rates and the one exact conversion every screen uses
 * (AGENTS.md §3vvv).
 *
 * Rates are "ILS per 1 unit of the foreign currency", stored as
 * Decimal(12,6). They are carried here as whole MILLIONTHS (micros), an
 * exact integer, never a float: 3.037667 is 3_037_667. Converting an agorot
 * amount is then pure integer arithmetic,
 *
 *     minor units = agorot × 1_000_000 ÷ micros,  rounded half away from zero,
 *
 * done in BigInt so no value, however large, and no rate, however awkward,
 * can round differently on two screens or two machines.
 *
 * Days are UTC calendar days ("YYYY-MM-DD"), the convention the rest of the
 * app already uses for months and snapshots. 23:59:59Z on the 2nd is the
 * 2nd; 00:00:01Z on the 3rd is the 3rd.
 *
 * The rate for a day is the newest published rate on or before it. The ECB
 * (through Frankfurter) publishes on business days only, so a Saturday,
 * Sunday or holiday has no row and takes the last business day's rate —
 * which is also what the provider itself answers when asked for a weekend.
 * A day before the earliest stored rate takes the earliest one and is
 * flagged approximate.
 */

/** One stored rate: its UTC day and ILS-per-unit in millionths. */
export type RatePoint = { day: string; micros: number };

const MICROS_PER_UNIT = 1_000_000n;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** The UTC calendar day of an instant, as "YYYY-MM-DD". */
export function utcDayKey(value: Date | string): string {
  if (typeof value === "string" && DAY_KEY.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Not a date: ${String(value)}`);
  return date.toISOString().slice(0, 10);
}

/**
 * A stored Decimal(12,6) rate, from its exact text, as micros. Parsed as
 * text — not through a float — so "3.037667" is exactly 3_037_667.
 */
export function rateMicrosFromDecimal(text: string): number {
  const match = /^(\d+)(?:\.(\d{1,6})\d*)?$/.exec(text.trim());
  if (!match) throw new RangeError(`Not a positive decimal rate: ${text}`);
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? "").padEnd(6, "0"));
  const micros = whole * MICROS_PER_UNIT + fraction;
  if (micros <= 0n) throw new RangeError(`Rate must be positive: ${text}`);
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`Rate too large: ${text}`);
  return Number(micros);
}

/** A rate given as a number (the fallback table), rounded to the stored precision. */
export function rateMicrosFromNumber(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) throw new RangeError(`Rate must be a positive finite number: ${rate}`);
  return Math.round(rate * 1_000_000);
}

/**
 * agorot ÷ (micros / 1e6), rounded half away from zero, exactly. Accepts a
 * number or a bigint amount; the result is a safe-integer number of the
 * target currency's minor units.
 */
export function convertAgorotExact(amount: number | bigint, micros: number): number {
  if (!Number.isSafeInteger(micros) || micros <= 0) throw new RangeError(`Rate must be positive micros: ${micros}`);
  if (typeof amount === "number" && !Number.isSafeInteger(amount)) throw new RangeError(`Amount must be a safe integer: ${amount}`);
  const value = BigInt(amount);
  const rate = BigInt(micros);
  const magnitude = value < 0n ? -value : value;
  // round(m × 1e6 / r) half up on the magnitude: floor((2·m·1e6 + r) / 2r)
  const rounded = (2n * magnitude * MICROS_PER_UNIT + rate) / (2n * rate);
  const signed = value < 0n ? -rounded : rounded;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError("Converted amount is outside the safe integer range");
  }
  return Number(signed);
}

/**
 * The reverse direction: native minor units × (micros / 1e6), rounded half
 * away from zero, exactly. This is the one conversion that turns an amount
 * entered or imported in a foreign currency into the agorot the ledger
 * stores, so the stored `exchangeRateAtEntry` × `nativeAmount` always
 * reproduces the stored `amount` to the agorah (AGENTS.md §3www).
 *
 * A float `amount * rate` cannot promise that: on a product that lands
 * exactly on half an agorah it rounds the wrong way about one time in
 * seven (100,000 at 0.285085 is 28,508.5, which float arithmetic sees as
 * 28,508.4999… and rounds down).
 */
export function convertNativeToAgorotExact(amount: number | bigint, micros: number): number {
  if (!Number.isSafeInteger(micros) || micros <= 0) throw new RangeError(`Rate must be positive micros: ${micros}`);
  if (typeof amount === "number" && !Number.isSafeInteger(amount)) throw new RangeError(`Amount must be a safe integer: ${amount}`);
  const value = BigInt(amount);
  const magnitude = value < 0n ? -value : value;
  // round(m × r / 1e6) half up on the magnitude: floor((2·m·r + 1e6) / 2e6)
  const rounded = (2n * magnitude * BigInt(micros) + MICROS_PER_UNIT) / (2n * MICROS_PER_UNIT);
  const signed = value < 0n ? -rounded : rounded;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError("Converted amount is outside the safe integer range");
  }
  return Number(signed);
}

/**
 * Micros as the exact six-decimal text a `Decimal(12,6)` column stores:
 * 3_037_667 → "3.037667". Writing this string (never a float) is what keeps
 * the stored rate identical to the one the conversion used.
 */
export function formatRateMicros(micros: number): string {
  if (!Number.isSafeInteger(micros) || micros <= 0) throw new RangeError(`Rate must be positive micros: ${micros}`);
  const text = String(micros).padStart(7, "0");
  return `${text.slice(0, -6)}.${text.slice(-6)}`;
}

export type RateOnDay = {
  micros: number;
  /** The day the rate was published, or null when no rate exists at all (a fallback). */
  rateDay: string | null;
  /** True when the day is before every stored rate, or none exists. */
  approximate: boolean;
};

/**
 * The rate for a UTC day: the newest point on or before it (a weekend or
 * holiday takes the last business day); before the first point, the first
 * point, approximate; with no points, the fallback. `history` must be sorted
 * by day, oldest first — `sortRateHistory` does that.
 */
export function rateOnDay(history: readonly RatePoint[], day: string, fallbackMicros: number): RateOnDay {
  if (history.length === 0) return { micros: fallbackMicros, rateDay: null, approximate: true };
  let low = 0;
  let high = history.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (history[middle].day <= day) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (found === -1) return { micros: history[0].micros, rateDay: history[0].day, approximate: true };
  return { micros: history[found].micros, rateDay: history[found].day, approximate: false };
}

/** Oldest first, one point per day (the last given wins), invalid entries dropped. */
export function sortRateHistory(points: readonly RatePoint[]): RatePoint[] {
  const byDay = new Map<string, number>();
  for (const point of points) {
    if (DAY_KEY.test(point.day) && Number.isSafeInteger(point.micros) && point.micros > 0) byDay.set(point.day, point.micros);
  }
  return [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([day, micros]) => ({ day, micros }));
}
