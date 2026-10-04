/**
 * Exact arithmetic on decimal STRINGS — the long-term core mirror's
 * counterpart to `money.ts`'s integer law.
 *
 * The core's router writes every quantity, price and notional as a
 * decimal string (`Decimal` on its side, `str(...)` in its journal), and a
 * share quantity has up to nine decimals. Turning `"0.123456789"` into a
 * JS `number` and multiplying by a price is exactly the float round trip
 * the money law forbids, so anything that has to turn two of these
 * strings into a money figure goes through `BigInt` here instead: parse to
 * `units / 10^scale`, multiply the integers, and round once, at the end,
 * to whole cents.
 *
 * Rounding is half away from zero (so half a cent rounds to a cent, and
 * minus half a cent to minus a cent) — the same convention as
 * `exchange-rate.ts`'s conversions, so a figure derived here never
 * disagrees by a cent with the same figure derived there.
 *
 * Display only. Nothing in this app stores a figure that came out of
 * `formatDecimalTrimmed`; it exists so a quantity shown on a page reads as
 * `12.5` rather than `12.500000000`.
 */

export type ParsedDecimal = { units: bigint; scale: number };

const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/;

/** A fraction longer than this is not something Alpaca (nine) or the policy (a few) ever produces; refusing it bounds the work a hostile payload can ask for. */
const MAX_FRACTION_DIGITS = 30;

export function parseDecimalString(input: string): ParsedDecimal {
  if (!DECIMAL_PATTERN.test(input)) {
    throw new RangeError(`Not a plain decimal string: ${JSON.stringify(input)}`);
  }
  const negative = input.startsWith("-");
  const unsigned = negative ? input.slice(1) : input;
  const [whole, fraction = ""] = unsigned.split(".");
  if (fraction.length > MAX_FRACTION_DIGITS) {
    throw new RangeError(`Decimal has more than ${MAX_FRACTION_DIGITS} fractional digits`);
  }
  const units = BigInt(whole + fraction);
  return { units: negative ? -units : units, scale: fraction.length };
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/** `numerator / denominator` (denominator positive), rounded half away from zero. */
function divideRoundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const quotient = magnitude / denominator;
  const rounded = (magnitude % denominator) * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

function toSafeInteger(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} exceeds the safe integer range`);
  }
  return Number(value);
}

/** `a × b` (both dollar-denominated decimal strings, e.g. a quantity and a price) as whole cents. */
export function multiplyDecimalsToCents(a: string, b: string): number {
  const left = parseDecimalString(a);
  const right = parseDecimalString(b);
  const cents = divideRoundHalfAwayFromZero(left.units * right.units * 100n, pow10(left.scale + right.scale));
  return toSafeInteger(cents, "Product in cents");
}

/**
 * The exact sum of `a × b` over every pair, truncated (not rounded) to
 * whole cents. This is how the router records a plan's traded dollars
 * (`ROUND_DOWN` on the sum of every fill's quantity times price), so the
 * figure shown here is the same one `core_ctl status` and the paper report
 * print — rounding each fill first and adding would drift from it by a
 * cent or two.
 */
export function sumProductsToCentsTruncated(pairs: ReadonlyArray<readonly [string, string]>): number {
  let sum = 0n;
  let sumScale = 0;
  for (const [a, b] of pairs) {
    const left = parseDecimalString(a);
    const right = parseDecimalString(b);
    const units = left.units * right.units;
    const scale = left.scale + right.scale;
    if (scale > sumScale) {
      sum *= pow10(scale - sumScale);
      sumScale = scale;
    }
    sum += units * pow10(sumScale - scale);
  }
  // BigInt division truncates toward zero, which is exactly the rounding wanted here.
  return toSafeInteger((sum * 100n) / pow10(sumScale), "Sum in cents");
}

/** A dollar-denominated decimal string as whole cents. */
export function decimalToCents(value: string): number {
  const parsed = parseDecimalString(value);
  return toSafeInteger(divideRoundHalfAwayFromZero(parsed.units * 100n, pow10(parsed.scale)), "Amount in cents");
}

/** A fraction of one (a portfolio weight such as `"0.19"`) as basis points. */
export function decimalToBasisPoints(value: string): number {
  const parsed = parseDecimalString(value);
  return toSafeInteger(divideRoundHalfAwayFromZero(parsed.units * 10_000n, pow10(parsed.scale)), "Weight in basis points");
}

/**
 * Display text for a decimal string: trailing zeros (and a bare point)
 * dropped, the fraction optionally cut to `maxFractionDigits` by
 * truncation. Anything that is not a plain decimal is returned untouched —
 * this runs over text that came off the wire, and a label must never be
 * the thing that throws.
 */
export function formatDecimalTrimmed(value: string, maxFractionDigits?: number): string {
  if (!DECIMAL_PATTERN.test(value)) return value;
  const [whole, fraction = ""] = value.split(".");
  const cut = maxFractionDigits === undefined ? fraction : fraction.slice(0, maxFractionDigits);
  const trimmed = cut.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

/**
 * A decimal string rounded half away from zero to exactly `places`
 * fractional digits (padded with zeros if it had fewer), in exact integer
 * arithmetic. A value that rounds to zero is `0.00`, never `-0.00`.
 * Anything that is not a plain decimal is returned untouched.
 */
export function roundDecimalString(value: string, places: number): string {
  if (!DECIMAL_PATTERN.test(value)) return value;
  const parsed = parseDecimalString(value);
  const scaled =
    parsed.scale <= places
      ? parsed.units * pow10(places - parsed.scale)
      : divideRoundHalfAwayFromZero(parsed.units, pow10(parsed.scale - places));
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places);
  return `${negative ? "-" : ""}${whole}${places > 0 ? `.${fraction}` : ""}`;
}
