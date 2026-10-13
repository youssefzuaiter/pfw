import "server-only";
import { cache } from "react";
import { FALLBACK_RATES } from "../../lib/exchange-rate";
import { ILS_REPORTING, formatReportingAmount, type ReportingContext } from "../../lib/reporting-currency";
import type { Agorot } from "../../lib/money";
import { getLatestRate } from "../dal/exchange-rates";
import { getReportingCurrency } from "../dal/user-settings";

/**
 * The user's reporting currency and the rate to show it at (AGENTS.md
 * §3nnn), resolved once per request — `cache()`, never `'use cache'`, the
 * same per-user reasoning as every other `build-*-data.ts` (§3c).
 *
 * The latest synced rate, like every other live figure in this app (law
 * #5); with none synced yet, the hardcoded fallback, and `rateDay: null`
 * so the page can say the rate is approximate.
 */
export const getReportingContext = cache(async (userId: string): Promise<ReportingContext> => {
  const currency = await getReportingCurrency(userId);
  if (currency === "ILS") return ILS_REPORTING;
  const latest = await getLatestRate(currency);
  if (!latest) return { currency, ilsPerUnit: FALLBACK_RATES[currency], rateDay: null };
  return { currency, ilsPerUnit: latest.rate, rateDay: latest.asOfDate.toISOString().slice(0, 10) };
});

/** A formatter bound to this user's reporting context, for server code that builds display text. */
export async function getReportingFormatter(userId: string): Promise<(value: Agorot, options?: { showPositiveSign?: boolean }) => string> {
  const context = await getReportingContext(userId);
  return (value, options) => formatReportingAmount(value, context, options);
}
