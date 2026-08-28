"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { agorot, formatAgorot } from "../../../lib/money";

type ChartPoint = { dateLabel: string; dateKey: number; price: number };

function PriceTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value?: number }>; label?: string }) {
  if (!active || !payload?.length || payload[0].value === undefined) return null;
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-lg">
      <p className="text-muted">{label}</p>
      <p className="font-tabular-figures font-medium text-fg">{formatAgorot(agorot(Math.round(payload[0].value)))}</p>
    </div>
  );
}

export function PriceChart({ history }: { history: readonly { date: Date; price: number }[] }) {
  if (history.length === 0) {
    return <p className="text-sm text-muted">No price history available.</p>;
  }

  const data: ChartPoint[] = history.map((point) => ({
    dateLabel: point.date.toISOString().slice(5, 10),
    dateKey: point.date.getTime(),
    price: point.price,
  }));

  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis dataKey="dateLabel" className="fill-muted text-xs" tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis
            className="fill-muted text-xs"
            tickLine={false}
            axisLine={false}
            width={64}
            tickFormatter={(value: number) => formatAgorot(agorot(Math.round(value)))}
          />
          <Tooltip content={<PriceTooltip />} />
          <Area
            type="monotone"
            dataKey="price"
            className="fill-accent/20 stroke-accent"
            strokeWidth={2}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
