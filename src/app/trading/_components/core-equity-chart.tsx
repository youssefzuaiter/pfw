"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { nativeAmount, formatNativeAmount } from "../../../lib/currency";
import { useIsClient } from "../../../lib/hooks/use-is-client";
import type { EquityPoint, EquitySummary } from "../../../lib/core-equity";

const usd = (cents: number) => formatNativeAmount(nativeAmount(cents), "USD");

function signedUsd(cents: number): string {
  if (cents === 0) return usd(0);
  return `${cents > 0 ? "+" : "−"}${usd(Math.abs(cents))}`;
}

/** A return as a signed percent (`+2.50%`). Not `formatSignedBps`, which prints percentage POINTS (`pp`), a difference of two shares. */
function signedPercent(bps: number): string {
  if (bps === 0) return "0.00%";
  return `${bps > 0 ? "+" : "−"}${(Math.abs(bps) / 100).toFixed(2)}%`;
}

function EquityTooltip({ active, payload }: { active?: boolean; payload?: { payload?: EquityPoint }[] }) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-lg">
      <p className="text-muted">{point.day}</p>
      <p className="font-tabular-figures font-medium tracking-tight text-fg">{usd(point.usdCents)}</p>
    </div>
  );
}

/**
 * The long-term core's account value over time (AGENTS.md §3hhh): one
 * point per day, from the router's own snapshots. A line needs two points,
 * and until the router has reported on two different days the section says
 * so instead of drawing one dot.
 *
 * In US dollars, the account's own currency, and not switched by the
 * app-wide currency toggle: converting every historic point at today's
 * shekel rate would fold a currency move into a line meant to show the
 * account. The headline figures above it are the live conversions.
 *
 * The y-axis does not start at zero. An account that moves a percent or two
 * would be a flat line on a zero-based axis; the axis shows the range the
 * account actually travelled, and the summary line gives the change in
 * plain numbers so the picture is never the only evidence.
 */
export function CoreEquityChart({
  points,
  summary,
}: {
  points: readonly EquityPoint[];
  summary: EquitySummary | null;
}) {
  const isClient = useIsClient();

  if (!summary || points.length < 2) {
    return (
      <p className="text-sm text-muted">
        The chart appears once the router has reported on at least two different days. Each point is the last account
        snapshot of a day.
      </p>
    );
  }

  const direction = summary.changeUsdCents === 0 ? "flat" : summary.changeUsdCents > 0 ? "up" : "down";
  const description = `Account value in US dollars, ${summary.firstDay} to ${summary.lastDay}: from ${usd(
    summary.firstUsdCents,
  )} to ${usd(summary.lastUsdCents)}, ${direction} ${usd(Math.abs(summary.changeUsdCents))}.`;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-fg">
        <span
          className={`font-tabular-figures font-medium tracking-tight ${
            summary.changeUsdCents < 0 ? "text-negative" : summary.changeUsdCents > 0 ? "text-positive" : "text-fg"
          }`}
        >
          {signedUsd(summary.changeUsdCents)}
          {summary.changeBps !== null && <> ({signedPercent(summary.changeBps)})</>}
        </span>{" "}
        <span className="text-muted">
          since {summary.firstDay}, {summary.spanDays === 1 ? "1 day" : `${summary.spanDays} days`}
        </span>
      </p>

      <div role="img" aria-label={description} className="h-56 w-full">
        {/* Mounted after hydration only: see useIsClient for why server-rendered Recharts logs a CSP violation. */}
        {isClient && (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={[...points]} margin={{ top: 4, right: 20, left: 8, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--pfw-border)" />
              <XAxis
                dataKey="day"
                tick={{ fontSize: 11 }}
                stroke="var(--pfw-muted)"
                tickFormatter={(day: string) => day.slice(5)}
                minTickGap={24}
              />
              {/* 84px fits a six-figure dollar tick: a right-aligned tick wider than the reserved width loses its leading digits (AGENTS.md §3tt). */}
              <YAxis
                tick={{ fontSize: 11 }}
                stroke="var(--pfw-muted)"
                tickFormatter={(cents: number) => usd(cents)}
                domain={["auto", "auto"]}
                width={84}
              />
              <Tooltip content={<EquityTooltip />} />
              <Line
                type="monotone"
                dataKey="usdCents"
                stroke="var(--pfw-accent)"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <p className="text-xs text-muted">
        One point per day: the last account snapshot the router took that day. This is the account&rsquo;s value, so a
        top-up or a reset of the paper account would show as a jump, not as performance. Paper money.
      </p>
    </div>
  );
}
