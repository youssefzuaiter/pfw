"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { agorot, formatAgorot } from "../../../lib/money";

type MonthPoint = { monthKey: string; income: number; expense: number };

function IncomeExpenseTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; dataKey?: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-lg">
      <p className="text-muted">{label}</p>
      {payload.map((entry) =>
        entry.value === undefined ? null : (
          <p key={entry.dataKey} className="font-tabular-figures font-medium text-fg">
            {entry.name}: {formatAgorot(agorot(Math.round(entry.value)))}
          </p>
        ),
      )}
    </div>
  );
}

export function IncomeExpenseChart({ history }: { history: readonly MonthPoint[] }) {
  if (history.length === 0) {
    return <p className="text-sm text-muted">Not enough history yet.</p>;
  }

  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={[...history]} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
          <XAxis
            dataKey="monthKey"
            className="fill-muted text-xs"
            tickLine={false}
            axisLine={false}
            tickFormatter={(value: string) => value.slice(5)}
          />
          <YAxis hide />
          <Tooltip content={<IncomeExpenseTooltip />} />
          <Bar dataKey="income" name="Income" className="fill-positive" isAnimationActive={false} radius={[2, 2, 0, 0]} />
          <Bar dataKey="expense" name="Expense" className="fill-negative" isAnimationActive={false} radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
