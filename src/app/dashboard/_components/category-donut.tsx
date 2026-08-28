"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { agorot, formatAgorot } from "../../../lib/money";

type Slice = { categoryName: string; amount: number };

const SLICE_FILL_CLASSES = ["fill-accent", "fill-positive", "fill-signature", "fill-negative", "fill-muted"];
const SLICE_DOT_CLASSES = ["bg-accent", "bg-positive", "bg-signature", "bg-negative", "bg-muted"];
const MAX_SLICES = 6;

function DonutTooltip({ active, payload }: { active?: boolean; payload?: Array<{ name?: string; value?: number }> }) {
  if (!active || !payload?.length || payload[0].value === undefined) return null;
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-lg">
      <p className="text-fg">{payload[0].name}</p>
      <p className="font-tabular-figures font-medium text-fg">{formatAgorot(agorot(Math.round(payload[0].value)))}</p>
    </div>
  );
}

export function CategoryDonut({ breakdown }: { breakdown: readonly Slice[] }) {
  if (breakdown.length === 0) {
    return <p className="text-sm text-muted">No categorized spending yet this month.</p>;
  }

  const data = breakdown.slice(0, MAX_SLICES);

  return (
    <div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="amount"
              nameKey="categoryName"
              innerRadius="55%"
              outerRadius="80%"
              paddingAngle={2}
              isAnimationActive={false}
            >
              {data.map((entry, index) => (
                <Cell key={entry.categoryName} className={SLICE_FILL_CLASSES[index % SLICE_FILL_CLASSES.length]} stroke="none" />
              ))}
            </Pie>
            <Tooltip content={<DonutTooltip />} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {data.map((entry, index) => (
          <li key={entry.categoryName} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${SLICE_DOT_CLASSES[index % SLICE_DOT_CLASSES.length]}`} aria-hidden="true" />
            {entry.categoryName}
          </li>
        ))}
      </ul>
    </div>
  );
}
