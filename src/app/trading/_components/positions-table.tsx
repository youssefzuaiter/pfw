import { Badge, type BadgeVariant } from "../../../components/badge/badge";
import { formatNativeAmount } from "../../../lib/currency";
import { formatAgorot } from "../../../lib/money";
import type { AssetClass } from "../../../lib/portfolio-analytics";
import type { PortfolioRow } from "../../../server/portfolio/build-portfolio-data";

const CLASS_LABEL: Record<AssetClass, string> = {
  STOCK: "Stock",
  ETF: "ETF",
  CRYPTO: "Crypto",
};

const CLASS_VARIANT: Record<AssetClass, BadgeVariant> = {
  STOCK: "neutral",
  ETF: "neutral",
  CRYPTO: "warning",
};

function toneClass(value: number): string {
  if (value > 0) return "text-positive";
  if (value < 0) return "text-negative";
  return "text-muted";
}

function formatRate(rate: number | null): string {
  if (rate === null) return "—";
  const sign = rate > 0 ? "+" : "";
  return `${sign}${(rate * 100).toFixed(2)}%`;
}

/**
 * Yield of exactly zero is a real answer for a non-distributing asset
 * (crypto, growth stocks), not missing data — so it renders as "0.00%"
 * while a genuinely undefined yield (zero market value) renders as "—".
 */
function formatYield(trailingYield: number | null): string {
  if (trailingYield === null) return "—";
  return `${(trailingYield * 100).toFixed(2)}%`;
}

export function PositionsTable({ rows }: { rows: PortfolioRow[] }) {
  return (
    // Wide table scrolls inside its own container rather than making the
    // page body scroll horizontally on mobile.
    <div className="overflow-x-auto">
      <table className="w-full min-w-[44rem] border-collapse text-sm">
        <caption className="sr-only">Open portfolio positions with market value, return, and dividend yield</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <th scope="col" className="pb-2 pr-3 font-medium">Symbol</th>
            <th scope="col" className="pb-2 pr-3 font-medium">Qty</th>
            <th scope="col" className="pb-2 pr-3 text-right font-medium">Cost basis</th>
            <th scope="col" className="pb-2 pr-3 text-right font-medium">Market value</th>
            <th scope="col" className="pb-2 pr-3 text-right font-medium">Unrealized</th>
            <th scope="col" className="pb-2 text-right font-medium">Yield (12mo)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.symbol} className="border-b border-border last:border-b-0">
              <td className="py-3 pr-3">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-fg">{row.symbol}</span>
                  <Badge variant={CLASS_VARIANT[row.assetClass]}>{CLASS_LABEL[row.assetClass]}</Badge>
                </div>
                <p className="text-xs text-muted">{row.name}</p>
              </td>
              <td className="py-3 pr-3 font-tabular-figures text-fg">{row.quantity}</td>
              <td className="py-3 pr-3 text-right font-tabular-figures text-fg">{formatAgorot(row.costBasis)}</td>
              <td className="py-3 pr-3 text-right">
                <p className="font-tabular-figures text-fg">{formatAgorot(row.marketValue)}</p>
                <p className="font-tabular-figures text-xs text-muted">
                  {formatNativeAmount(row.nativeMarketValue, row.currency)}
                </p>
              </td>
              <td className="py-3 pr-3 text-right">
                <p className={`font-tabular-figures ${toneClass(row.unrealizedGain)}`}>
                  {formatAgorot(row.unrealizedGain, { showPositiveSign: true })}
                </p>
                <p className={`font-tabular-figures text-xs ${toneClass(row.unrealizedGain)}`}>
                  {formatRate(row.unrealizedReturnRate)}
                </p>
              </td>
              <td className="py-3 text-right font-tabular-figures text-fg">{formatYield(row.trailingYield)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
