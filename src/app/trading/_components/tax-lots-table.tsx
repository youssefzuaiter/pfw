import { Badge, type BadgeVariant } from "../../../components/badge/badge";
import { agorot, formatAgorot } from "../../../lib/money";
import type { TaxSimulationResponse } from "../../../server/tax/build-tax-data";

const TERM_BADGE: Record<TaxSimulationResponse["openLots"][number]["term"], { label: string; variant: BadgeVariant }> = {
  SHORT: { label: "Short-term", variant: "warning" },
  LONG: { label: "Long-term", variant: "positive" },
  FLAT: { label: "Flat-rate", variant: "neutral" },
};

function gainClassName(value: number): string {
  if (value > 0) return "text-positive";
  if (value < 0) return "text-negative";
  return "text-muted";
}

/** Every open FIFO/LIFO tax lot — one row per still-unsold acquisition, oldest lots first within a symbol under FIFO, newest under LIFO (the ordering the simulation itself already produced upstream). */
export function TaxLotsTable({ rows }: { rows: TaxSimulationResponse["openLots"] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <th className="py-2 pr-3 font-medium">Symbol</th>
            <th className="py-2 pr-3 font-medium">Acquired</th>
            <th className="py-2 pr-3 font-medium text-right">Quantity</th>
            <th className="py-2 pr-3 font-medium text-right">Cost basis</th>
            <th className="py-2 pr-3 font-medium text-right">Current value</th>
            <th className="py-2 pr-3 font-medium text-right">Unrealized gain</th>
            <th className="py-2 pr-3 font-medium text-right">Held</th>
            <th className="py-2 font-medium">Term</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((lot, index) => {
            const term = TERM_BADGE[lot.term];
            return (
              <tr key={`${lot.symbol}-${lot.acquiredAt}-${index}`} className="border-b border-border/60 last:border-b-0">
                <td className="py-2 pr-3">
                  <p className="font-medium text-fg">{lot.symbol}</p>
                  <p className="text-xs text-muted">{lot.symbolName}</p>
                </td>
                <td className="py-2 pr-3 font-tabular-figures text-muted">{lot.acquiredAt.slice(0, 10)}</td>
                <td className="py-2 pr-3 text-right font-tabular-figures text-fg">{lot.quantity.toFixed(4)}</td>
                <td className="py-2 pr-3 text-right font-tabular-figures text-fg">
                  {formatAgorot(agorot(lot.costBasis.agorot))}
                </td>
                <td className="py-2 pr-3 text-right font-tabular-figures text-fg">
                  {formatAgorot(agorot(lot.currentValue.agorot))}
                </td>
                <td className={`py-2 pr-3 text-right font-tabular-figures ${gainClassName(lot.unrealizedGain.agorot)}`}>
                  {formatAgorot(agorot(lot.unrealizedGain.agorot), { showPositiveSign: true })}
                </td>
                <td className="py-2 pr-3 text-right font-tabular-figures text-muted">{lot.holdingPeriodDays}d</td>
                <td className="py-2">
                  <Badge variant={term.variant}>{term.label}</Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
