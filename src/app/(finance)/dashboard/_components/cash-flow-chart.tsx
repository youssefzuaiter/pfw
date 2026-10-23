"use client";

import { Area, AreaChart, CartesianGrid, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useReportingMoney } from "../../../../components/currency/reporting-currency-provider";
import { agorot } from "../../../../lib/money";

type ForecastPoint = { date: Date; balance: number };
type Minimum = { date: Date; balance: number };

function ForecastTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value?: number }>; label?: string }) {
  const money = useReportingMoney();
  if (!active || !payload?.length || payload[0].value === undefined) return null;
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-lg">
      <p className="text-muted">{label}</p>
      <p className="font-tabular-figures font-medium tracking-tight text-fg">
        {money.format(agorot(Math.round(payload[0].value)))}
      </p>
    </div>
  );
}

export function CashFlowChart({
  days,
  minimum,
  bills,
}: {
  days: readonly ForecastPoint[];
  minimum: Minimum;
  /** The charges from the bills typed in that the forecast includes. */
  bills?: { count: number; totalAgorot: number };
}) {
  const money = useReportingMoney();
  const data = days.map((d) => ({ dateLabel: d.date.toISOString().slice(5, 10), dateKey: d.date.getTime(), balance: d.balance }));
  const minimumPoint = data.find((d) => d.dateKey === minimum.date.getTime());

  return (
    <div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
            <XAxis dataKey="dateLabel" className="fill-muted text-xs" tickLine={false} axisLine={false} interval={9} />
            <YAxis hide domain={["dataMin", "dataMax"]} />
            <Tooltip content={<ForecastTooltip />} />
            <Area
              type="monotone"
              dataKey="balance"
              className="stroke-accent fill-accent"
              fillOpacity={0.12}
              strokeWidth={2}
              isAnimationActive={false}
            />
            {minimumPoint && (
              <ReferenceDot
                x={minimumPoint.dateLabel}
                y={minimumPoint.balance}
                r={5}
                className="fill-negative stroke-negative"
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-2 text-xs text-muted">
        Lowest projected balance:{" "}
        <span className="font-tabular-figures font-medium tracking-tight text-negative">
          {money.format(agorot(minimum.balance))}
        </span>{" "}
        on {minimum.date.toISOString().slice(0, 10)}
      </p>
      {bills && bills.count > 0 && (
        <p className="mt-1 text-xs text-muted">
          Includes {bills.count} {bills.count === 1 ? "charge" : "charges"} from the bills you added,{" "}
          <span className="font-tabular-figures tracking-tight">{money.format(agorot(bills.totalAgorot))}</span> in all.
        </p>
      )}
    </div>
  );
}
