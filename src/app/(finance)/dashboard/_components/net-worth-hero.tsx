import { ReportingAmount } from "../../../../components/currency/reporting-currency-provider";
import { agorot, type Agorot } from "../../../../lib/money";
import { NetWorthChange } from "./net-worth-change";
import { NetWorthSparkline } from "./net-worth-sparkline";

type NetWorth = {
  totalAssets: Agorot;
  totalLiabilities: Agorot;
  netWorth: Agorot;
};

type HistoryPoint = { date: Date; netWorth: Agorot };

export function NetWorthHero({ netWorth, history }: { netWorth: NetWorth; history: readonly HistoryPoint[] }) {

  return (
    <section className="rounded-lg border border-border bg-surface p-4" aria-labelledby="net-worth-heading">
      <h2 id="net-worth-heading" className="text-xs font-medium uppercase tracking-wide text-muted">
        Net worth
      </h2>
      <div className="mt-2 flex flex-wrap items-baseline gap-3">
        <p className="font-tabular-figures text-4xl font-semibold tracking-tight text-fg">
          <ReportingAmount value={netWorth.netWorth} />
        </p>
        <NetWorthChange current={netWorth.netWorth} first={history[0] ?? null} days={history.length} />
      </div>
      <div className="mt-4 h-16">
        <NetWorthSparkline history={history.map((h) => ({ date: h.date, netWorth: agorot(h.netWorth) }))} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
        <div>
          <dt className="text-xs text-muted">Assets</dt>
          <dd className="font-tabular-figures font-medium tracking-tight text-fg"><ReportingAmount value={netWorth.totalAssets} /></dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Liabilities</dt>
          <dd className="font-tabular-figures font-medium tracking-tight text-fg"><ReportingAmount value={netWorth.totalLiabilities} /></dd>
        </div>
      </dl>
    </section>
  );
}
