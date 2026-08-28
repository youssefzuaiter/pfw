/**
 * Integer money primitives — the single source of truth for the
 * "money is never a float" law.
 *
 * Every monetary figure in PFW is an integer number of agorot
 * (1 shekel = 100 agorot, e.g. ₪125.50 = 12550 agorot). `Agorot` is a
 * branded number so a plain `number` can't be passed where an amount is
 * expected without going through `agorot()` first.
 */

const brand = Symbol("Agorot");

export type Agorot = number & { readonly [brand]: true };

function assertFiniteInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new RangeError(`${label} must be an integer, received ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} exceeds the safe integer range: ${value}`);
  }
}

/** Smart constructor — the only way to produce an `Agorot` from a raw number. */
export function agorot(value: number): Agorot {
  assertFiniteInteger(value, "Agorot amount");
  return value as Agorot;
}

export const ZERO_AGOROT = agorot(0);

export function addAgorot(...values: Agorot[]): Agorot {
  return agorot(values.reduce((sum, v) => sum + v, 0));
}

export function subtractAgorot(a: Agorot, b: Agorot): Agorot {
  return agorot(a - b);
}

export function negateAgorot(a: Agorot): Agorot {
  return agorot(-a);
}

export function absAgorot(a: Agorot): Agorot {
  return agorot(Math.abs(a));
}

export function compareAgorot(a: Agorot, b: Agorot): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function isZeroAgorot(a: Agorot): boolean {
  return a === 0;
}

export function isNegativeAgorot(a: Agorot): boolean {
  return a < 0;
}

/**
 * Scales an amount by a plain ratio (e.g. a proration fraction or a
 * percentage-of-cents split) and rounds to the nearest whole agorot,
 * half away from zero.
 *
 * This is the one place a float (`factor`) legitimately touches a monetary
 * value: `factor` is a dimensionless ratio, not itself money, and the
 * result is rounded back to an exact integer agorot before it is ever
 * stored or compared — so no fractional-agorot drift can accumulate.
 */
export function multiplyAgorot(value: Agorot, factor: number): Agorot {
  if (!Number.isFinite(factor)) {
    throw new RangeError(`Scale factor must be finite, received ${factor}`);
  }
  const scaled = value * factor;
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
  return agorot(rounded);
}

/**
 * Splits `total` across `ratios` so the parts sum to exactly `total` —
 * the largest-remainder method, which prevents the "rounding drift" bug
 * where naively rounding each share independently loses or gains agorot.
 */
export function allocateAgorot(total: Agorot, ratios: number[]): Agorot[] {
  if (ratios.length === 0) {
    if (total !== 0) {
      throw new RangeError("Cannot allocate a non-zero amount across zero shares");
    }
    return [];
  }
  if (ratios.some((r) => r < 0 || !Number.isFinite(r))) {
    throw new RangeError("Allocation ratios must be finite and non-negative");
  }
  const ratioSum = ratios.reduce((sum, r) => sum + r, 0);
  if (ratioSum === 0) {
    throw new RangeError("Allocation ratios must not all be zero");
  }

  const sign = total < 0 ? -1 : 1;
  const magnitude = Math.abs(total);

  const shares = ratios.map((ratio) => (magnitude * ratio) / ratioSum);
  const floors = shares.map((s) => Math.floor(s));
  let remainder = magnitude - floors.reduce((sum, f) => sum + f, 0);

  const remainders = shares
    .map((s, index) => ({ index, fraction: s - floors[index] }))
    .sort((a, b) => b.fraction - a.fraction);

  const result = [...floors];
  for (const { index } of remainders) {
    if (remainder <= 0) break;
    result[index] += 1;
    remainder -= 1;
  }

  return result.map((n) => agorot(sign * n));
}

const SHEKEL_STRING_PATTERN = /^-?(?:₪\s?)?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?$|^-?(?:₪\s?)?\d+(?:\.\d{1,2})?$/;

/**
 * Parses a decimal shekel string (e.g. from CSV import or a form field)
 * into `Agorot`, entirely via string/integer arithmetic — never via
 * `parseFloat(...) * 100`, which can introduce binary-floating-point
 * artifacts before the value is ever rounded.
 */
export function parseShekelsToAgorot(input: string): Agorot {
  const trimmed = input.trim();
  if (!SHEKEL_STRING_PATTERN.test(trimmed)) {
    throw new RangeError(`Not a valid shekel amount: ${JSON.stringify(input)}`);
  }

  const negative = trimmed.startsWith("-");
  const unsigned = trimmed
    .replace(/^-/, "")
    .replace(/₪\s?/, "")
    .replace(/,/g, "");

  const [wholePart, fractionPart = ""] = unsigned.split(".");
  const cents = (fractionPart + "00").slice(0, 2);

  const wholeAgorot = Number(wholePart) * 100;
  const fractionAgorot = Number(cents);
  const total = wholeAgorot + fractionAgorot;

  return agorot(negative ? -total : total);
}

/**
 * The single auditable formatting utility for the app's one currency
 * token (₪). Every screen that displays a monetary figure goes through
 * this function — there is no other place amounts are turned into text.
 */
export function formatAgorot(value: Agorot, options: { showPositiveSign?: boolean } = {}): string {
  const isNegative = value < 0;
  const magnitude = Math.abs(value);
  const wholeShekels = Math.trunc(magnitude / 100);
  const cents = magnitude % 100;

  const groupedShekels = wholeShekels.toLocaleString("en-US");
  const centsText = cents.toString().padStart(2, "0");

  const sign = isNegative ? "-" : options.showPositiveSign && magnitude > 0 ? "+" : "";

  return `${sign}₪${groupedShekels}.${centsText}`;
}
