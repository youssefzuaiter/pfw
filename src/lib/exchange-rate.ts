/**
 * Exchange-rate conversion math. A rate here is always expressed as
 * "base-currency (ILS) units per 1 unit of the foreign currency" — e.g.
 * `{ currency: "USD", rate: 3.7 }` means 1 USD = 3.70 ILS.
 *
 * A rate is a dimensionless ratio, not itself money — the same reasoning
 * `money.ts`'s `multiplyAgorot` doc comment gives for why its `factor`
 * parameter is a plain float: nothing derived from it is ever stored or
 * compared until it has been rounded back to an exact integer minor-unit
 * amount. This module is pure (no DB access) — the actual rate values
 * come from the `ExchangeRate` table via a DAL lookup, or from
 * `FALLBACK_RATES` below when no live rate has been synced yet.
 */

import { agorot, type Agorot } from "./money";
import { BASE_CURRENCY, nativeAmount, type CurrencyCode, type NativeAmount } from "./currency";

/** ILS per 1 unit of the given currency. Used only when no synced rate exists yet
 * (a fresh install, or the sync service's own fetch is unavailable) — see
 * src/server/currency/ (the background sync service) for how these back a real fetch. */
export const FALLBACK_RATES: Readonly<Record<Exclude<CurrencyCode, "ILS">, number>> = {
  USD: 3.7,
  EUR: 4.0,
  GBP: 4.7,
};

/** Rate of the base currency against itself — always exactly 1, never looked up. */
export const IDENTITY_RATE = 1;

export function assertValidRate(rate: number, currency: CurrencyCode): void {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new RangeError(`Exchange rate for ${currency} must be a positive finite number, received ${rate}`);
  }
}

/**
 * Converts a native-currency minor-unit amount into base-currency
 * (ILS) `Agorot`, given the ILS-per-1-unit rate for that currency.
 *
 * Correct without any per-currency scale factor because ILS, USD, EUR,
 * and GBP all share the same 2-decimal minor-unit convention
 * (`currency.ts`'s `MINOR_UNITS_PER_WHOLE`): a native amount and an
 * Agorot amount are both "whole units × 100", so multiplying the raw
 * minor-unit integer by the rate already yields the agorot minor-unit
 * result directly, with no separate unit-scale conversion needed. This
 * would need adjusting if a zero-decimal currency (e.g. JPY) were ever
 * added to `SUPPORTED_CURRENCIES`.
 */
export function convertNativeAmountToAgorot(amount: NativeAmount, currency: CurrencyCode, rate: number): Agorot {
  if (currency === BASE_CURRENCY) {
    return agorot(amount);
  }
  assertValidRate(rate, currency);
  const scaled = amount * rate;
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
  return agorot(rounded);
}

/**
 * The inverse conversion — base-currency `Agorot` back into a native
 * amount, e.g. to show "this ILS budget limit is roughly $X" without
 * ever persisting the result (it's a display-only approximation, not a
 * historical fact, so it deliberately returns a plain `NativeAmount` the
 * caller must treat as informational).
 */
export function convertAgorotToNativeAmount(amount: Agorot, currency: CurrencyCode, rate: number): NativeAmount {
  if (currency === BASE_CURRENCY) {
    return nativeAmount(amount);
  }
  assertValidRate(rate, currency);
  const scaled = amount / rate;
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
  return nativeAmount(rounded);
}

/** "3.7" -> "3.7000" for consistent-width display in rate tables/tooltips. */
export function formatExchangeRate(rate: number, currency: CurrencyCode, fractionDigits = 4): string {
  assertValidRate(rate, currency);
  return rate.toFixed(fractionDigits);
}
