import {
  BASE_CURRENCY,
  CURRENCY_SYMBOLS,
  formatNativeAmount,
  nativeAmount,
  type CurrencyCode,
  type NativeAmount,
} from "./currency";
import { convertAgorotToNativeAmount } from "./exchange-rate";
import { agorot, formatAgorot, type Agorot } from "./money";

/**
 * The currency totals are SHOWN in (AGENTS.md §3nnn). Display only: every
 * amount is still stored and summed in ILS agorot (law #3), and becomes
 * this currency only on its way to text, through `formatReportingAmount`.
 *
 * Serializable on purpose — the server resolves it once per request and
 * hands the same object to client components, so a figure rendered on the
 * server and one rendered in the browser use the same rate.
 */
export type ReportingContext = {
  currency: CurrencyCode;
  /** ILS per 1 unit of `currency` (the rate table's convention); 1 for ILS. */
  ilsPerUnit: number;
  /** The UTC day of the rate in use, or null when no rate was ever synced and a fallback is being used (or for ILS). */
  rateDay: string | null;
};

export const ILS_REPORTING: ReportingContext = { currency: BASE_CURRENCY, ilsPerUnit: 1, rateDay: null };

export function isConvertedReporting(context: ReportingContext): boolean {
  return context.currency !== BASE_CURRENCY;
}

/**
 * An ILS agorot amount in the reporting currency's minor units, rounded
 * half away from zero. An integer — for charts, which plot the converted
 * values so their axis ticks fall on round figures of the shown currency.
 */
export function toReportingMinorUnits(value: Agorot, context: ReportingContext): NativeAmount {
  return convertAgorotToNativeAmount(value, context.currency, context.ilsPerUnit);
}

/** Formats minor units ALREADY in the reporting currency (e.g. a chart tick). */
export function formatReportingMinorUnits(
  minorUnits: number,
  context: ReportingContext,
  options: { showPositiveSign?: boolean } = {},
): string {
  const whole = Math.round(minorUnits);
  return context.currency === BASE_CURRENCY
    ? formatAgorot(agorot(whole), options)
    : formatNativeAmount(nativeAmount(whole), context.currency, options);
}

/** An ILS agorot amount as text in the reporting currency. With ILS this is exactly `formatAgorot`. */
export function formatReportingAmount(
  value: Agorot,
  context: ReportingContext,
  options: { showPositiveSign?: boolean } = {},
): string {
  if (context.currency === BASE_CURRENCY) return formatAgorot(value, options);
  return formatNativeAmount(toReportingMinorUnits(value, context), context.currency, options);
}

/** "₪3.7012 per $1, rate of 2026-10-12" — what a converted page says about itself. Null for ILS. */
export function describeReportingRate(context: ReportingContext): string | null {
  if (!isConvertedReporting(context)) return null;
  const symbol = CURRENCY_SYMBOLS[context.currency];
  const rate = `₪${context.ilsPerUnit.toFixed(4)} per ${symbol}1`;
  return context.rateDay ? `${rate}, rate of ${context.rateDay}` : `${rate}, an approximate rate (none synced yet)`;
}
