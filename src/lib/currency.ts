/**
 * Multi-currency support (amendment to AGENTS.md's original "single
 * currency (shekels)" law — see AGENTS.md §3k for the full rationale).
 *
 * ILS remains the app's one *base* currency: every aggregate figure (net
 * worth, dashboard totals, insight generators) is still computed in ILS
 * agorot via `money.ts`, and `formatAgorot` is still the only place a
 * base-currency amount becomes display text. This module adds a parallel,
 * clearly-separate representation for amounts that are natively
 * denominated in a foreign currency (a USD bank account, a EUR-priced
 * transaction, a USD equity trade) — `NativeAmount`, the same
 * integer-minor-units discipline as `Agorot`, just not assumed to be ILS.
 *
 * A native amount is only ever a display/native-aggregation concern; it
 * is converted to a base-currency `Agorot` (via exchange-rate.ts) at the
 * point each model needs one, and that conversion is either a live lookup
 * (an account's current balance) or a frozen historical fact (a completed
 * transaction or trade) — never both, per model. See prisma/schema.prisma
 * for which is which.
 */

import { assertFiniteInteger, agorot, type Agorot } from "./money";

export type CurrencyCode = "ILS" | "USD" | "EUR" | "GBP";

/** The app's one base/reporting currency — never changes at runtime. */
export const BASE_CURRENCY: CurrencyCode = "ILS";

export const SUPPORTED_CURRENCIES: readonly CurrencyCode[] = ["ILS", "USD", "EUR", "GBP"];

/**
 * All four currencies use a 2-decimal-place minor unit (100 subunits to
 * one whole unit) — this is what lets exchange-rate.ts's conversion
 * formula apply a rate directly to a minor-unit amount with no
 * currency-specific scaling. Revisit if a zero-decimal currency (e.g.
 * JPY) is ever added.
 */
export const MINOR_UNITS_PER_WHOLE = 100;

export const CURRENCY_SYMBOLS: Record<CurrencyCode, string> = {
  ILS: "₪",
  USD: "$",
  EUR: "€",
  GBP: "£",
};

export function isSupportedCurrency(value: string): value is CurrencyCode {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

const brand = Symbol("NativeAmount");

/**
 * An integer number of minor units (cents, agorot, pence, ...) in some
 * *non-assumed* currency — always paired with an explicit `CurrencyCode`
 * by whatever holds it, since a bare `NativeAmount` doesn't carry its own
 * currency the way `Agorot` implicitly means ILS.
 */
export type NativeAmount = number & { readonly [brand]: true };

/** Smart constructor — the only way to produce a `NativeAmount` from a raw number. */
export function nativeAmount(value: number): NativeAmount {
  assertFiniteInteger(value, "Native amount");
  return value as NativeAmount;
}

export const ZERO_NATIVE_AMOUNT = nativeAmount(0);

export function addNativeAmounts(...values: NativeAmount[]): NativeAmount {
  return nativeAmount(values.reduce((sum, v) => sum + v, 0));
}

export function subtractNativeAmounts(a: NativeAmount, b: NativeAmount): NativeAmount {
  return nativeAmount(a - b);
}

export function negateNativeAmount(a: NativeAmount): NativeAmount {
  return nativeAmount(-a);
}

export function absNativeAmount(a: NativeAmount): NativeAmount {
  return nativeAmount(Math.abs(a));
}

export function compareNativeAmounts(a: NativeAmount, b: NativeAmount): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function isZeroNativeAmount(a: NativeAmount): boolean {
  return a === 0;
}

export function isNegativeNativeAmount(a: NativeAmount): boolean {
  return a < 0;
}

/** Same rounding convention as `money.ts`'s `multiplyAgorot` — half away from zero. */
export function multiplyNativeAmount(value: NativeAmount, factor: number): NativeAmount {
  if (!Number.isFinite(factor)) {
    throw new RangeError(`Scale factor must be finite, received ${factor}`);
  }
  const scaled = value * factor;
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
  return nativeAmount(rounded);
}

/**
 * Converts a `NativeAmount` to the base currency's `Agorot` type with no
 * rate applied — valid only when `currency` already IS the base currency
 * (ILS), since in that case a minor unit of the currency literally is an
 * agorot. Exists so ILS-native rows (the common case) never have to go
 * through a real exchange-rate lookup at all.
 */
export function nativeAmountToBaseAgorot(value: NativeAmount, currency: CurrencyCode): Agorot {
  if (currency !== BASE_CURRENCY) {
    throw new RangeError(
      `nativeAmountToBaseAgorot() only accepts the base currency (${BASE_CURRENCY}); received ${currency}. Use exchange-rate.ts's convertNativeAmountToAgorot() for a foreign currency.`,
    );
  }
  return agorot(value);
}

const DECIMAL_STRING_PATTERN = /^-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?$|^-?\d+(?:\.\d{1,2})?$/;

/**
 * Parses a plain decimal string (e.g. "1,234.56" or "-42") into a
 * `NativeAmount`, via string/integer arithmetic only — the same
 * discipline as `money.ts`'s `parseShekelsToAgorot`, generalized to any
 * currency. Unlike `parseShekelsToAgorot`, this never matches a currency
 * symbol itself — native amounts are always paired with an explicit
 * `currency` field elsewhere (a form's currency dropdown, a CSV
 * adapter's declared currency), so there's no `₪`/`$`/`€`/`£` ambiguity
 * to resolve here.
 */
export function parseDecimalToNativeAmount(input: string): NativeAmount {
  const trimmed = input.trim();
  if (!DECIMAL_STRING_PATTERN.test(trimmed)) {
    throw new RangeError(`Not a valid decimal amount: ${JSON.stringify(input)}`);
  }

  const negative = trimmed.startsWith("-");
  const unsigned = trimmed.replace(/^-/, "").replace(/,/g, "");

  const [wholePart, fractionPart = ""] = unsigned.split(".");
  const minorUnits = (fractionPart + "00").slice(0, 2);

  const wholeMinorUnits = Number(wholePart) * MINOR_UNITS_PER_WHOLE;
  const fractionMinorUnits = Number(minorUnits);
  const total = wholeMinorUnits + fractionMinorUnits;

  return nativeAmount(negative ? -total : total);
}

/**
 * The formatting counterpart to `money.ts`'s `formatAgorot`, for a
 * *native*, non-base-currency amount — the only other place a monetary
 * value becomes display text. Always tags the figure with its currency
 * symbol so it's never mistaken for a base-currency (₪) amount, even in a
 * mixed-currency list.
 */
export function formatNativeAmount(
  value: NativeAmount,
  currency: CurrencyCode,
  options: { showPositiveSign?: boolean } = {},
): string {
  const isNegative = value < 0;
  const magnitude = Math.abs(value);
  const wholeUnits = Math.trunc(magnitude / MINOR_UNITS_PER_WHOLE);
  const minorUnits = magnitude % MINOR_UNITS_PER_WHOLE;

  const groupedWholeUnits = wholeUnits.toLocaleString("en-US");
  const minorUnitsText = minorUnits.toString().padStart(2, "0");

  const sign = isNegative ? "-" : options.showPositiveSign && magnitude > 0 ? "+" : "";

  return `${sign}${CURRENCY_SYMBOLS[currency]}${groupedWholeUnits}.${minorUnitsText}`;
}
