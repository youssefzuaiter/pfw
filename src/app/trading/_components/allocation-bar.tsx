import { formatAgorot } from "../../../lib/money";
import type { AllocationSlice, AssetClass } from "../../../lib/portfolio-analytics";

const CLASS_LABEL: Record<AssetClass, string> = {
  STOCK: "Stocks",
  ETF: "ETFs",
  CRYPTO: "Crypto",
};

/**
 * Tokenized fills only — never a raw hex literal
 * (tests/guards/no-untokenized-hex.test.ts). Reusing the existing
 * accent/signature/positive tokens keeps this consistent with the rest of
 * the app rather than introducing a fourth chart palette.
 */
const CLASS_FILL: Record<AssetClass, string> = {
  STOCK: "bg-accent",
  ETF: "bg-signature",
  CRYPTO: "bg-positive",
};

/**
 * A single stacked bar rather than a donut: with at most three asset
 * classes, a donut would be more chart than the data warrants, and a
 * stacked bar keeps the exact percentages legible in the legend beneath.
 * No animation — these are live financial figures (Section 5).
 */
export function AllocationBar({ allocation }: { allocation: AllocationSlice[] }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-3 overflow-hidden rounded-full bg-bg" role="presentation">
        {allocation.map((slice) => (
          <div
            key={slice.assetClass}
            className={CLASS_FILL[slice.assetClass]}
            style={{ width: `${slice.share * 100}%` }}
          />
        ))}
      </div>

      <ul className="flex flex-wrap gap-x-6 gap-y-2">
        {allocation.map((slice) => (
          <li key={slice.assetClass} className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${CLASS_FILL[slice.assetClass]}`} aria-hidden="true" />
            <span className="text-sm text-fg">{CLASS_LABEL[slice.assetClass]}</span>
            <span className="font-tabular-figures text-sm text-muted">
              {(slice.share * 100).toFixed(1)}% · {formatAgorot(slice.marketValue)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
