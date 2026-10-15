import "server-only";
import { cache } from "react";
import { FALLBACK_RATES } from "../../lib/exchange-rate";
import { ILS_REPORTING, formatReportingAmount, type ReportingContext } from "../../lib/reporting-currency";
import type { Agorot } from "../../lib/money";
import { listRatePoints } from "../dal/exchange-rates";
import { rateMicrosFromNumber, utcDayKey } from "../../lib/fx-history";
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
  // Today's rate is the newest stored one on or before today (a future-dated
  // row, which the sync never writes, is ignored).
  const today = utcDayKey(new Date());
  const history = (await listRatePoints(currency)).filter((point) => point.day <= today);
  const latest = history.at(-1);
  if (!latest) {
    const ilsPerUnit = FALLBACK_RATES[currency];
    return { currency, ilsPerUnit, latestMicros: rateMicrosFromNumber(ilsPerUnit), rateDay: null, history: [] };
  }
  return { currency, ilsPerUnit: latest.micros / 1_000_000, latestMicros: latest.micros, rateDay: latest.day, history };
});

/** A formatter bound to this user's reporting context, for server code that builds display text. */
export async function getReportingFormatter(userId: string): Promise<(value: Agorot, options?: { showPositiveSign?: boolean }) => string> {
  const context = await getReportingContext(userId);
  return (value, options) => formatReportingAmount(value, context, options);
}
