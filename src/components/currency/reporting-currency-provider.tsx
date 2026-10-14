"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  ILS_REPORTING,
  describeReportingRate,
  describeReportingRateRule,
  flowInReporting,
  formatReportingAmount,
  formatReportingAmountOn,
  formatReportingFlow,
  formatReportingMinorUnits,
  toReportingMinorUnits,
  toReportingMinorUnitsOn,
  type ReportingContext,
  type ReportingFlow,
} from "../../lib/reporting-currency";
import type { CurrencyCode } from "../../lib/currency";
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
  /** An ILS agorot amount as text in the reporting currency, at today's rate (balances, budgets, plans). */
  format: (value: Agorot, options?: { showPositiveSign?: boolean }) => string;
  /** The same at the rate of a past day (a snapshot's own day). */
  formatOn: (value: Agorot, on: Date | string, options?: { showPositiveSign?: boolean }) => string;
  /** One movement of money, at the rate of the day it happened (or exactly, when recorded in the reporting currency). */
  formatFlow: (flow: ReportingFlow, options?: { showPositiveSign?: boolean }) => string;
  /** An ILS agorot amount in the reporting currency's minor units at today's rate (for chart data). */
  toMinor: (value: Agorot) => number;
  /** The same at the rate of a past day. */
  toMinorOn: (value: Agorot, on: Date | string) => number;
  /** One movement of money in minor units (see formatFlow). */
  flowMinor: (flow: ReportingFlow) => number;
  /** Minor units already in the reporting currency as text (for chart ticks). */
  formatMinor: (minorUnits: number, options?: { showPositiveSign?: boolean }) => string;
};

/**
 * One ILS agorot amount as text in the reporting currency — for a Server
 * Component that renders a figure as a JSX child and has no context of its
 * own to read (a server component cannot call `useReportingMoney`).
 */
/** An ILS agorot figure in the reporting currency: at today's rate, or at the rate of `on` for a figure that belongs to a past day. */
export function ReportingAmount({ value, showPositiveSign, on }: { value: number; showPositiveSign?: boolean; on?: Date | string }) {
  const money = useReportingMoney();
  const amount = agorot(value);
  return <>{on === undefined ? money.format(amount, { showPositiveSign }) : money.formatOn(amount, on, { showPositiveSign })}</>;
}

/** One transaction's amount in the reporting currency: at its own day's rate, or exact when recorded in that currency. */
export function ReportingFlowAmount({
  amount,
  occurredAt,
  currency,
  nativeAmount,
  showPositiveSign,
}: {
  amount: number;
  occurredAt: Date | string;
  currency?: CurrencyCode;
  nativeAmount?: number;
  showPositiveSign?: boolean;
}) {
  const money = useReportingMoney();
  return <>{money.formatFlow({ amount, occurredAt, currency, nativeAmount }, { showPositiveSign })}</>;
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
      Totals shown in {CURRENCY_NAMES[context.currency]}; today&rsquo;s rate is {rate}. {describeReportingRateRule(context)} Amounts are
      recorded in shekels.
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
      formatOn: (value, on, options) => formatReportingAmountOn(value, on, context, options),
      formatFlow: (flow, options) => formatReportingFlow(flow, context, options),
      toMinor: (value) => toReportingMinorUnits(value, context),
      toMinorOn: (value, on) => toReportingMinorUnitsOn(value, on, context),
      flowMinor: (flow) => flowInReporting(flow, context),
      formatMinor: (minorUnits, options) => formatReportingMinorUnits(minorUnits, context, options),
    }),
    [context],
  );
}
