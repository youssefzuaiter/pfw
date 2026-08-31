"use client";

import { useEffect, useRef, useState } from "react";
import { Area, AreaChart, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge } from "../../../components/badge/badge";
import { Spinner } from "../../../components/spinner/spinner";
import { agorot, formatAgorot, type Agorot } from "../../../lib/money";
import type { ForecastDayResult } from "../../../workers/forecaster-worker-handlers";
import { runForecast } from "../../../workers/forecaster-client";

type Status = "loading" | "ready" | "error" | "unsupported";

type ChartPoint = {
  day: number;
  date: string;
  p5: number;
  band: number; // p95 - p5, stacked on top of p5 — this is what actually draws the shaded cone
  p50: number;
  mean: number;
};

function toChartData(days: readonly ForecastDayResult[]): ChartPoint[] {
  return days.map((d) => ({
    day: d.dayIndex,
    date: d.date,
    p5: d.p5Agorot,
    band: Math.max(0, d.p95Agorot - d.p5Agorot),
    p50: d.p50Agorot,
    mean: d.meanAgorot,
  }));
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { payload?: ChartPoint }[];
  label?: number;
}) {
  if (!active || !payload?.length?.valueOf()) return null;
  const point = payload[0]?.payload;
  if (!point) return null;
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-lg">
      <p className="text-muted">
        Day {label} · {point.date}
      </p>
      <p className="font-tabular-figures text-fg">95th pct: {formatAgorot(agorot(point.p5 + point.band))}</p>
      <p className="font-tabular-figures font-medium text-fg">Median: {formatAgorot(agorot(point.p50))}</p>
      <p className="font-tabular-figures text-fg">5th pct: {formatAgorot(agorot(point.p5))}</p>
    </div>
  );
}

/**
 * Client-side stochastic 30-day cash-flow projection (AGENTS.md §3dd) —
 * a small PyTorch-trained LSTM (scripts/train-forecaster.py), run
 * entirely in the browser via ONNX Runtime Web inside
 * src/workers/forecaster.worker.ts. No financial data ever leaves the
 * device to compute this, the same property this app's other
 * client-side models already hold (§3u, §3aa).
 *
 * Runs the forecast exactly once, on mount — the Worker is created,
 * used for its one `forecast` call, and terminated
 * (src/workers/forecaster-client.ts's own `finally` block) every time,
 * never kept warm. That's a deliberate difference from the embedding
 * Worker's "stay warm across many interactive calls" lifecycle: this
 * card computes once per dashboard load, so there's no later call to
 * optimize for keeping it alive.
 */
export function RunwayForecastChart({
  startingLiquidAgorot,
  dailyHistory,
}: {
  startingLiquidAgorot: Agorot;
  dailyHistory: readonly { dateKey: string; netAgorot: number }[];
}) {
  const [status, setStatus] = useState<Status>("loading");
  const [chartData, setChartData] = useState<ChartPoint[] | null>(null);
  const requestedRef = useRef(false);

  useEffect(() => {
    if (requestedRef.current) return; // React 19 Strict Mode double-invokes effects — never run this twice
    requestedRef.current = true;

    // Every setState call below runs inside this deferred microtask, not
    // synchronously in the effect body — same react-hooks/set-state-in-effect
    // avoidance monte-carlo-widget.tsx's/transactions-explorer.tsx's own
    // debounced-fetch effects already establish (AGENTS.md §3cc).
    void (async () => {
      if (typeof Worker === "undefined") {
        setStatus("unsupported");
        return;
      }

      try {
        const response = await runForecast({
          startingBalanceAgorot: startingLiquidAgorot,
          dailyHistoryAgorot: dailyHistory.map((d) => d.netAgorot),
          dates: dailyHistory.map((d) => d.dateKey),
        });
        setChartData(toChartData(response.days));
        setStatus("ready");
      } catch {
        setStatus("error");
      }
    })();
    // Runs once on mount with the props as they were at that moment —
    // this card doesn't re-forecast on every prop identity change, only
    // on a genuine remount (a full page navigation, which is when
    // dailyHistory/startingLiquidAgorot would actually change anyway).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-semibold text-fg">30-Day Cash-Flow Forecast</h2>
        {status === "loading" && <Spinner size="sm" />}
        {status === "ready" && <Badge variant="neutral">experimental</Badge>}
      </div>

      {status === "loading" && <p className="py-8 text-center text-sm text-muted">Running the on-device forecast…</p>}

      {status === "unsupported" && (
        <p className="py-8 text-center text-sm text-muted">
          Your browser doesn&rsquo;t support the Web Worker this forecast runs in.
        </p>
      )}

      {status === "error" && (
        <p className="py-8 text-center text-sm text-muted">
          Couldn&rsquo;t run the forecast this time — your other dashboard figures are unaffected.
        </p>
      )}

      {status === "ready" && chartData && (
        <>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--pfw-border)" />
                <XAxis
                  dataKey="day"
                  tick={{ fontSize: 11 }}
                  stroke="var(--pfw-muted)"
                  label={{ value: "Days ahead", position: "insideBottom", offset: -2, fontSize: 11 }}
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  stroke="var(--pfw-muted)"
                  tickFormatter={(value: number) => formatAgorot(agorot(value))}
                  width={90}
                />
                <Tooltip content={<ChartTooltip />} />
                <Area
                  type="monotone"
                  dataKey="p5"
                  stackId="cone"
                  stroke="none"
                  fill="transparent"
                  isAnimationActive={false}
                />
                <Area
                  type="monotone"
                  dataKey="band"
                  stackId="cone"
                  stroke="none"
                  fill="var(--pfw-accent)"
                  fillOpacity={0.15}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="p50"
                  stroke="var(--pfw-accent)"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-2 text-xs text-muted">
            Shaded band: 5th-95th percentile across 200 simulated paths. Line: median projection. A small model
            trained on synthetic cash-flow patterns, not a guarantee — same spirit as the retirement Monte Carlo
            projection, treat it as a range to plan around, not a prediction to bank on.
          </p>
        </>
      )}
    </div>
  );
}
