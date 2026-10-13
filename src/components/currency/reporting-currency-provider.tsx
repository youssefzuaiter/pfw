"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  ILS_REPORTING,
  describeReportingRate,
  formatReportingAmount,
  formatReportingMinorUnits,
  toReportingMinorUnits,
  type ReportingContext,
} from "../../lib/reporting-currency";
import { agorot, type Agorot } from "../../lib/money";

/**
 * Hands the server-resolved reporting context (AGENTS.md §3nnn) to client
 * components. The default is ILS, so a component rendered outside the
 * provider — every existing component test — formats exactly as before.
 */
const ReportingCurrencyContext = createContext<ReportingContext>(ILS_REPORTING);

export function ReportingCurrencyProvider({ value, children }: { value: ReportingContext; children: ReactNode }) {
  return <ReportingCurrencyContext value={value}>{children}</ReportingCurrencyContext>;
}

export type ReportingMoney = {
  context: ReportingContext;
  /** An ILS agorot amount as text in the reporting currency. */
  format: (value: Agorot, options?: { showPositiveSign?: boolean }) => string;
  /** An ILS agorot amount in the reporting currency's minor units (for chart data). */
  toMinor: (value: Agorot) => number;
  /** Minor units already in the reporting currency as text (for chart ticks). */
  formatMinor: (minorUnits: number, options?: { showPositiveSign?: boolean }) => string;
};

/**
 * One ILS agorot amount as text in the reporting currency — for a Server
 * Component that renders a figure as a JSX child and has no context of its
 * own to read (a server component cannot call `useReportingMoney`).
 */
export function ReportingAmount({ value, showPositiveSign }: { value: number; showPositiveSign?: boolean }) {
  const money = useReportingMoney();
  return <>{money.format(agorot(value), { showPositiveSign })}</>;
}

/**
 * What a converted page says about its own figures: the currency, the rate
 * and its day. Nothing when the reporting currency is ILS, since nothing is
 * converted then.
 */
export function ReportingRateNote({ className = "text-xs text-muted" }: { className?: string }) {
  const { context } = useReportingMoney();
  const rate = describeReportingRate(context);
  if (!rate) return null;
  return (
    <p className={className}>
      Totals shown in {CURRENCY_NAMES[context.currency]} at {rate}. Amounts are recorded in shekels.
    </p>
  );
}

const CURRENCY_NAMES: Record<ReportingContext["currency"], string> = {
  ILS: "shekels",
  USD: "US dollars",
  EUR: "euros",
  GBP: "pounds",
  TRY: "lira",
};

export function useReportingMoney(): ReportingMoney {
  const context = useContext(ReportingCurrencyContext);
  return useMemo(
    () => ({
      context,
      format: (value, options) => formatReportingAmount(value, context, options),
      toMinor: (value) => toReportingMinorUnits(value, context),
      formatMinor: (minorUnits, options) => formatReportingMinorUnits(minorUnits, context, options),
    }),
    [context],
  );
}
