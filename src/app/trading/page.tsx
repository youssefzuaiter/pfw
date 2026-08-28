import Link from "next/link";
import { Badge } from "../../components/badge/badge";
import { getMockPriceAgorot, getMockPriceHistory, listMockSymbols } from "../../lib/mock-market-data";
import { agorot, formatAgorot, multiplyAgorot, subtractAgorot } from "../../lib/money";
import { unrealizedPnl } from "../../lib/portfolio-math";
import { getCurrentUser } from "../../server/auth/current-user";
import { listPortfolioHoldings, listTrades } from "../../server/dal/portfolio";
import { PriceChart } from "./_components/price-chart";
import { TradeForm } from "./_components/trade-form";

export const instant = false;

function firstParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

function pnlClassName(value: bigint): string {
  if (value > 0n) return "text-positive";
  if (value < 0n) return "text-negative";
  return "text-muted";
}

export default async function TradingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const symbols = listMockSymbols();
  const requestedSymbol = firstParam(params.symbol).toUpperCase();
  const selectedSymbol = symbols.includes(requestedSymbol) ? requestedSymbol : symbols[0];

  const user = await getCurrentUser();
  const [holdings, trades] = await Promise.all([listPortfolioHoldings(user.id), listTrades(user.id)]);

  const now = new Date();
  const priceBySymbol = new Map(symbols.map((symbol) => [symbol, getMockPriceAgorot(symbol, now)]));
  const history = getMockPriceHistory(selectedSymbol, 30, now).map((point) => ({
    date: point.date,
    price: Number(point.price),
  }));

  const openHoldings = holdings.filter((holding) => holding.quantity.toNumber() > 0);
  const totalUnrealized = openHoldings.reduce((sum, holding) => {
    const price = priceBySymbol.get(holding.symbol);
    if (!price) return sum;
    const position = { quantity: holding.quantity.toNumber(), totalCostBasis: agorot(Number(holding.totalCostBasis)) };
    return sum + BigInt(unrealizedPnl(position, price));
  }, 0n);
  const totalRealized = trades.reduce(
    (sum, trade) => sum + (trade.realizedPnlAgorot !== null ? trade.realizedPnlAgorot : 0n),
    0n,
  );

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-6 md:px-6">
      <h1 className="font-display text-2xl font-semibold text-fg">Trading</h1>

      <section className="flex flex-wrap gap-6 rounded-lg border border-border bg-surface p-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Unrealized P&amp;L</p>
          <p className={`font-tabular-figures text-lg font-semibold ${pnlClassName(totalUnrealized)}`}>
            {formatAgorot(agorot(Number(totalUnrealized)))}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Realized P&amp;L</p>
          <p className={`font-tabular-figures text-lg font-semibold ${pnlClassName(totalRealized)}`}>
            {formatAgorot(agorot(Number(totalRealized)))}
          </p>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted">{selectedSymbol}</h2>
          <p className="font-tabular-figures text-lg font-semibold text-fg">
            {formatAgorot(priceBySymbol.get(selectedSymbol) ?? agorot(0))}
          </p>
        </div>
        <PriceChart history={history} />
        <div className="mt-3 flex flex-wrap gap-2">
          {symbols.map((symbol) => (
            <Link
              key={symbol}
              href={`/trading?symbol=${symbol}`}
              className={`rounded-full border px-3 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                symbol === selectedSymbol
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border text-muted hover:bg-bg"
              }`}
            >
              {symbol} · {formatAgorot(priceBySymbol.get(symbol) ?? agorot(0))}
            </Link>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">Place order</h2>
        <TradeForm symbols={symbols} defaultSymbol={selectedSymbol} />
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">Holdings</h2>
        {openHoldings.length === 0 ? (
          <p className="text-sm text-muted">No open positions.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {openHoldings.map((holding) => {
              const quantity = holding.quantity.toNumber();
              const costBasis = agorot(Number(holding.totalCostBasis));
              const price = priceBySymbol.get(holding.symbol);
              const marketValue = price ? multiplyAgorot(price, quantity) : agorot(0);
              const pnl = price
                ? unrealizedPnl({ quantity, totalCostBasis: costBasis }, price)
                : subtractAgorot(agorot(0), costBasis);

              return (
                <li key={holding.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0">
                  <div>
                    <p className="font-medium text-fg">{holding.symbol}</p>
                    <p className="font-tabular-figures text-xs text-muted">
                      {holding.quantity.toString()} sh · cost basis {formatAgorot(costBasis)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-tabular-figures text-sm text-fg">{formatAgorot(marketValue)}</p>
                    <p className={`font-tabular-figures text-xs ${pnlClassName(BigInt(pnl))}`}>{formatAgorot(pnl)}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">Trade blotter</h2>
        {trades.length === 0 ? (
          <p className="text-sm text-muted">No trades executed yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {trades.map((trade) => (
              <li key={trade.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="text-muted">{trade.executedAt.toISOString().slice(0, 19).replace("T", " ")}</span>
                <Badge variant={trade.side === "BUY" ? "positive" : "critical"}>{trade.side}</Badge>
                <span className="font-tabular-figures text-fg">
                  {trade.quantity.toString()} {trade.symbol}
                </span>
                <span className="font-tabular-figures text-fg">@ {formatAgorot(agorot(Number(trade.priceAgorot)))}</span>
                <span className="font-tabular-figures text-fg">{formatAgorot(agorot(Number(trade.totalAgorot)))}</span>
                {trade.realizedPnlAgorot !== null && (
                  <span className={`font-tabular-figures ${pnlClassName(trade.realizedPnlAgorot)}`}>
                    {formatAgorot(agorot(Number(trade.realizedPnlAgorot)))}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
