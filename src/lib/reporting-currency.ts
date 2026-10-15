import {
  BASE_CURRENCY,
  CURRENCY_SYMBOLS,
  formatNativeAmount,
  nativeAmount,
  type CurrencyCode,
  type NativeAmount,
} from "./currency";
import { convertAgorotExact, rateOnDay, utcDayKey, type RatePoint } from "./fx-history";
import { agorot, formatAgorot, type Agorot } from "./money";

/**
 * The currency totals are SHOWN in (AGENTS.md §3nnn). Display only: every
 * amount is still stored and summed in ILS agorot (law #3), and becomes
 * this currency only on its way to text.
 *
 * Which rate (§3vvv):
 * - Money that moved on a day — a transaction, a month's income or spending
 *   — converts at THAT day's rate (`*On`, `*Flow`). A total over a period is
 *   the sum of its transactions, each converted on its own day and rounded
 *   on its own, so every way of slicing a period (by month, by category,
 *   in the email, on the review page) adds up to the same figure.
 * - A historical balance (a net-worth snapshot) converts at its own day's rate.
 * - Everything that is a balance now, a budget, a plan or a projection
 *   converts at today's (newest) rate.
 *
 * Serializable on purpose — the server resolves it once per request (rate
 * history included) and hands the same object to client components, so a
 * figure rendered on the server and one rendered in the browser agree.
 */
export type ReportingContext = {
  currency: CurrencyCode;
  /** Today's rate: ILS per 1 unit of `currency` (the rate table's convention); 1 for ILS. */
  ilsPerUnit: number;
  /** Today's rate in millionths, the exact form every conversion uses. */
  latestMicros: number;
  /** The UTC day of today's rate, or null when no rate was ever synced and a fallback is being used (or for ILS). */
  rateDay: string | null;
  /** Every stored rate for `currency`, oldest first; empty for ILS or before any sync. */
  history: RatePoint[];
};

export const ILS_REPORTING: ReportingContext = { currency: BASE_CURRENCY, ilsPerUnit: 1, latestMicros: 1_000_000, rateDay: null, history: [] };

export function isConvertedReporting(context: ReportingContext): boolean {
  return context.currency !== BASE_CURRENCY;
}

/** A movement of money: its ILS agorot, its own currency and native amount, and when it happened. */
export type ReportingFlow = {
  amount: number | bigint;
  occurredAt: Date | string;
  currency?: CurrencyCode;
  nativeAmount?: number | bigint;
};

/**
 * An ILS agorot amount in the reporting currency's minor units at TODAY's
 * rate, rounded half away from zero, exactly. For balances, budgets, plans
 * and projections.
 */
export function toReportingMinorUnits(value: Agorot | number | bigint, context: ReportingContext): NativeAmount {
  if (!isConvertedReporting(context)) return nativeAmount(Number(value));
  return nativeAmount(convertAgorotExact(value, context.latestMicros));
}

/** The same at the rate of `on`'s UTC day (the last business day's on a weekend or holiday). */
export function toReportingMinorUnitsOn(value: Agorot | number | bigint, on: Date | string, context: ReportingContext): NativeAmount {
  if (!isConvertedReporting(context)) return nativeAmount(Number(value));
  const rate = rateOnDay(context.history, utcDayKey(on), context.latestMicros);
  return nativeAmount(convertAgorotExact(value, rate.micros));
}

/**
 * One movement of money in the reporting currency. Recorded in the
 * reporting currency itself, it is that exact amount — converting it to
 * shekels and back would only add rounding. Otherwise its ILS amount at the
 * rate of the day it happened.
 */
export function flowInReporting(flow: ReportingFlow, context: ReportingContext): NativeAmount {
  if (!isConvertedReporting(context)) return nativeAmount(Number(flow.amount));
  if (flow.currency === context.currency && flow.nativeAmount !== undefined) return nativeAmount(Number(flow.nativeAmount));
  return toReportingMinorUnitsOn(flow.amount, flow.occurredAt, context);
}

/** A period's total: every flow converted on its own day, then added. The one rule for totals. */
export function sumFlowsInReporting(flows: Iterable<ReportingFlow>, context: ReportingContext): NativeAmount {
  let total = 0;
  for (const flow of flows) total += flowInReporting(flow, context);
  if (!Number.isSafeInteger(total)) throw new RangeError("Total is outside the safe integer range");
  return nativeAmount(total);
}

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

/** An ILS agorot amount as text in the reporting currency, at today's rate. */
export function formatReportingAmount(
  value: Agorot,
  context: ReportingContext,
  options: { showPositiveSign?: boolean } = {},
): string {
  if (context.currency === BASE_CURRENCY) return formatAgorot(value, options);
  return formatNativeAmount(toReportingMinorUnits(value, context), context.currency, options);
}

/** The same at the rate of `on`'s day: for a figure that belongs to a date (a snapshot). */
export function formatReportingAmountOn(
  value: Agorot,
  on: Date | string,
  context: ReportingContext,
  options: { showPositiveSign?: boolean } = {},
): string {
  return formatReportingMinorUnits(toReportingMinorUnitsOn(value, on, context), context, options);
}

/** One movement of money as text in the reporting currency (see flowInReporting). */
export function formatReportingFlow(flow: ReportingFlow, context: ReportingContext, options: { showPositiveSign?: boolean } = {}): string {
  return formatReportingMinorUnits(flowInReporting(flow, context), context, options);
}

/** The rate note under a converted page's heading. */
export function describeReportingRate(context: ReportingContext): string | null {
  if (!isConvertedReporting(context)) return null;
  const symbol = CURRENCY_SYMBOLS[context.currency];
  const rate = `₪${context.ilsPerUnit.toFixed(4)} per ${symbol}1`;
  return context.rateDay ? `${rate}, rate of ${context.rateDay}` : `${rate}, an approximate rate (none synced yet)`;
}

/** The second sentence of the rate note: which figures use which rate. */
export function describeReportingRateRule(context: ReportingContext): string | null {
  if (!isConvertedReporting(context)) return null;
  const earliest = context.history[0]?.day;
  const coverage = earliest ? ` Rates are stored from ${earliest}; anything earlier uses that first rate.` : "";
  return `Income, spending and past balances use the rate of their own day (the last business day's on weekends and holidays); balances, budgets and plans use today's.${coverage}`;
}

/** A movement of money with the category it was filed under (for per-category totals). */
export type CategorizedFlow = ReportingFlow & { categoryId: string };

/**
 * Money in and money out per UTC calendar month ("YYYY-MM"), in the
 * reporting currency, both as positive magnitudes — each transaction
 * converted on its own day, then added (the one rule for totals). For ILS
 * it is exactly the stored agorot sums.
 */
export function incomeExpenseByMonthInReporting(
  flows: Iterable<ReportingFlow>,
  context: ReportingContext,
): Map<string, { income: number; expense: number }> {
  const months = new Map<string, { income: number; expense: number }>();
  for (const flow of flows) {
    const month = utcDayKey(flow.occurredAt).slice(0, 7);
    const value = flowInReporting(flow, context);
    const bucket = months.get(month) ?? { income: 0, expense: 0 };
    if (Number(flow.amount) > 0) bucket.income += value;
    else bucket.expense -= value;
    months.set(month, bucket);
  }
  return months;
}

/** Spending per category, a positive magnitude in the reporting currency; income is ignored. */
export function spendByCategoryInReporting(flows: Iterable<CategorizedFlow>, context: ReportingContext): Map<string, number> {
  const totals = new Map<string, number>();
  for (const flow of flows) {
    if (Number(flow.amount) >= 0) continue;
    totals.set(flow.categoryId, (totals.get(flow.categoryId) ?? 0) - flowInReporting(flow, context));
  }
  return totals;
}
