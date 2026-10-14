"use client";

import { useReportingMoney } from "../../../../components/currency/reporting-currency-provider";
import { agorot } from "../../../../lib/money";

/**
 * The net-worth change over the sparkline's span, measured in the currency
 * the figure above it is shown in (AGENTS.md §3vvv): today's net worth at
 * today's rate against the first snapshot at the rate of its own day. In
 * shekels it is exactly the old shekel-to-shekel change.
 */
export function NetWorthChange({
  current,
  first,
  days,
}: {
  current: number;
  first: { netWorth: number; date: Date | string } | null;
  days: number;
}) {
  const money = useReportingMoney();
  if (!first) return null;
  const now = money.toMinor(agorot(current));
  const then = money.toMinorOn(agorot(first.netWorth), first.date);
  if (then === 0) return null;
  const changePercent = ((now - then) / Math.abs(then)) * 100;

  return (
    <span className={`font-tabular-figures text-sm font-medium tracking-tight ${changePercent >= 0 ? "text-positive" : "text-negative"}`}>
      <span aria-hidden="true">{changePercent >= 0 ? "▲" : "▼"} </span>
      {Math.abs(changePercent).toFixed(1)}%
      <span className="sr-only">
        {" "}
        {changePercent >= 0 ? "up" : "down"} over the last {days} days
      </span>
    </span>
  );
}
