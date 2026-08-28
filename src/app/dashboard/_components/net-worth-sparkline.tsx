"use client";

import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";

type Point = { date: Date; netWorth: number };

/**
 * No live financial number in this app animates on load (Section 5) —
 * every chart here sets `isAnimationActive={false}` for that reason, not
 * just this one.
 */
export function NetWorthSparkline({ history }: { history: readonly Point[] }) {
  if (history.length < 2) {
    return (
      <div className="flex h-full items-center text-xs text-muted" role="status">
        Not enough history yet
      </div>
    );
  }

  const data = history.map((point) => ({ date: point.date.toISOString(), value: point.netWorth }));

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
        <YAxis domain={["dataMin", "dataMax"]} hide />
        <Area
          type="monotone"
          dataKey="value"
          className="stroke-accent fill-accent"
          fillOpacity={0.15}
          strokeWidth={2}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
