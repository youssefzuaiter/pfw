import { agorot, formatAgorot, type Agorot } from "../../../../lib/money";
import { NetWorthSparkline } from "./net-worth-sparkline";

type NetWorth = {
  totalAssets: Agorot;
  totalLiabilities: Agorot;
  netWorth: Agorot;
};

type HistoryPoint = { date: Date; netWorth: Agorot };

export function NetWorthHero({ netWorth, history }: { netWorth: NetWorth; history: readonly HistoryPoint[] }) {
  const first = history[0]?.netWorth;
  const changePercent = first !== undefined && first !== 0 ? ((netWorth.netWorth - first) / Math.abs(first)) * 100 : null;

  return (
    <section className="rounded-lg border border-slate-800/80 bg-slate-900 p-4" aria-labelledby="net-worth-heading">
      <h2 id="net-worth-heading" className="text-xs font-medium uppercase tracking-wide text-slate-400">
        Net worth
      </h2>
      <div className="mt-2 flex flex-wrap items-baseline gap-3">
        <p className="font-tabular-figures text-4xl font-semibold tracking-tight text-slate-100">
          {formatAgorot(netWorth.netWorth)}
        </p>
        {changePercent !== null && (
          <span
            className={`font-tabular-figures text-sm font-medium tracking-tight ${changePercent >= 0 ? "text-positive" : "text-negative"}`}
          >
            <span aria-hidden="true">{changePercent >= 0 ? "▲" : "▼"} </span>
            {Math.abs(changePercent).toFixed(1)}%
            <span className="sr-only"> {changePercent >= 0 ? "up" : "down"} over the last {history.length} days</span>
          </span>
        )}
      </div>
      <div className="mt-4 h-16">
        <NetWorthSparkline history={history.map((h) => ({ date: h.date, netWorth: agorot(h.netWorth) }))} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
        <div>
          <dt className="text-xs text-slate-400">Assets</dt>
          <dd className="font-tabular-figures font-medium tracking-tight text-slate-100">{formatAgorot(netWorth.totalAssets)}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-400">Liabilities</dt>
          <dd className="font-tabular-figures font-medium tracking-tight text-slate-100">{formatAgorot(netWorth.totalLiabilities)}</dd>
        </div>
      </dl>
    </section>
  );
}
