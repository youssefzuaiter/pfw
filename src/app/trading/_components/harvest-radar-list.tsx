import { Badge } from "../../../components/badge/badge";
import { agorot, formatAgorot } from "../../../lib/money";
import type { TaxSimulationResponse } from "../../../server/tax/build-tax-data";

/** Tax-loss harvesting candidates: open lots currently sitting at a loss, biggest loss first — see tax-loss-harvesting.ts for how the estimated savings and wash-sale flag are derived. */
export function HarvestRadarList({ candidates }: { candidates: TaxSimulationResponse["harvestCandidates"] }) {
  if (candidates.length === 0) {
    return <p className="text-sm text-muted">No open positions are currently sitting at a loss.</p>;
  }

  return (
    <ul className="flex flex-col gap-3">
      {candidates.map((candidate, index) => (
        <li
          key={`${candidate.symbol}-${candidate.acquiredAt}-${index}`}
          className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0"
        >
          <div>
            <div className="flex items-center gap-2">
              <p className="font-medium text-fg">
                {candidate.symbol} <span className="font-normal text-muted">· {candidate.symbolName}</span>
              </p>
              {candidate.washSaleRisk && (
                <Badge variant="critical" pulse>
                  Wash-sale risk
                </Badge>
              )}
            </div>
            <p className="font-tabular-figures text-xs text-muted">
              {candidate.quantity.toFixed(4)} sh · acquired {candidate.acquiredAt.slice(0, 10)} · held {candidate.holdingPeriodDays}d
            </p>
          </div>
          <div className="text-right">
            <p className="font-tabular-figures text-sm text-negative">{formatAgorot(agorot(candidate.unrealizedLoss.agorot))}</p>
            <p className="font-tabular-figures text-xs text-positive">
              ~{formatAgorot(agorot(candidate.estimatedTaxSavings.agorot))} est. savings
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
