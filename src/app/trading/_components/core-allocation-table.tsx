import { CurrencyAmount } from "../../../components/currency/currency-amount";
import { formatBps, formatSignedBps } from "../../../lib/core-format";
import { formatDecimalTrimmed } from "../../../lib/decimal-string";
import { nativeAmount } from "../../../lib/currency";
import { agorot } from "../../../lib/money";
import type { CoreAccountView } from "../../../server/core/build-core-agent-data";

function driftTone(driftBps: number | null): string {
  if (driftBps === null || driftBps === 0) return "text-muted";
  return "text-fg";
}

/**
 * Each holding's share of the account against the policy's target. The
 * policy rebalances quarterly, so a gap between quarter-ends is normal
 * and is shown plainly, with no threshold or colour of its own: the page
 * reports what the account holds, it does not second-guess the rule.
 */
export function CoreAllocationTable({ account }: { account: CoreAccountView }) {
  return (
    <>
      <PhoneHoldings account={account} />
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[30rem] border-collapse text-sm">
          <caption className="sr-only">Holdings of the long-term core against the policy&rsquo;s target weights</caption>
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <th scope="col" className="pb-2 pr-3 font-medium">Holding</th>
              <th scope="col" className="pb-2 pr-3 text-right font-medium">Market value</th>
              <th scope="col" className="pb-2 pr-3 text-right font-medium">Actual</th>
              <th scope="col" className="pb-2 pr-3 text-right font-medium">Target</th>
              <th scope="col" className="pb-2 text-right font-medium">Drift</th>
            </tr>
          </thead>
          <tbody>
            {account.rows.map((row) => (
              <tr key={row.symbol} className="border-b border-border">
                <th scope="row" className="py-3 pr-3 text-left font-medium text-fg">
                  {row.symbol}
                  <span className="block text-xs font-normal text-muted">{formatDecimalTrimmed(row.qty, 4)} sh</span>
                </th>
                <td className="py-3 pr-3 text-right">
                  {row.market ? (
                    <CurrencyAmount agorotValue={agorot(row.market.ilsAgorot)} nativeValue={nativeAmount(row.market.usdCents)} currency="USD" />
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="py-3 pr-3 text-right font-tabular-figures text-fg">{formatBps(row.actualBps)}</td>
                <td className="py-3 pr-3 text-right font-tabular-figures text-fg">{formatBps(row.targetBps)}</td>
                <td className={`py-3 text-right font-tabular-figures ${driftTone(row.driftBps)}`}>{formatSignedBps(row.driftBps)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-b border-border">
              <th scope="row" className="py-3 pr-3 text-left font-medium text-muted">Cash</th>
              <td className="py-3 pr-3 text-right">
                <CurrencyAmount agorotValue={agorot(account.cash.ilsAgorot)} nativeValue={nativeAmount(account.cash.usdCents)} currency="USD" />
              </td>
              <td className="py-3 pr-3 text-right font-tabular-figures text-fg">{formatBps(account.cashBps)}</td>
              <td className="py-3 pr-3" />
              <td className="py-3" />
            </tr>
            <tr>
              <th scope="row" className="py-3 pr-3 text-left font-medium text-fg">Equity</th>
              <td className="py-3 pr-3 text-right">
                <CurrencyAmount agorotValue={agorot(account.equity.ilsAgorot)} nativeValue={nativeAmount(account.equity.usdCents)} currency="USD" />
              </td>
              <td className="py-3 pr-3" />
              <td className="py-3 pr-3" />
              <td className="py-3" />
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

/**
 * The same holdings as a list, for a phone: the table has six columns and
 * the one that matters — how far each holding has drifted from its target
 * — is the one that would scroll off the right edge. Here each holding is
 * two lines, and the drift is on the second. Only one of the two is ever
 * visible (`hidden` / `sm:hidden` remove the other from layout and from
 * the accessibility tree), so a screen reader hears the holdings once.
 */
function PhoneHoldings({ account }: { account: CoreAccountView }) {
  return (
    <ul className="flex flex-col sm:hidden" aria-label="Holdings against the policy's target weights">
      {account.rows.map((row) => (
        <li key={row.symbol} className="border-b border-border py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-medium text-fg">{row.symbol}</p>
              <p className="text-xs text-muted">{formatDecimalTrimmed(row.qty, 4)} sh</p>
            </div>
            <div className="text-right">
              {row.market ? (
                <CurrencyAmount agorotValue={agorot(row.market.ilsAgorot)} nativeValue={nativeAmount(row.market.usdCents)} currency="USD" />
              ) : (
                <span className="text-muted">—</span>
              )}
            </div>
          </div>
          <p className="mt-1 font-tabular-figures text-xs text-muted">
            {formatBps(row.actualBps)} of {formatBps(row.targetBps)} target · {formatSignedBps(row.driftBps)}
          </p>
        </li>
      ))}
      <li className="border-b border-border py-3">
        <div className="flex items-start justify-between gap-3">
          <p className="text-muted">Cash · {formatBps(account.cashBps)}</p>
          <div className="text-right">
            <CurrencyAmount agorotValue={agorot(account.cash.ilsAgorot)} nativeValue={nativeAmount(account.cash.usdCents)} currency="USD" />
          </div>
        </div>
      </li>
      <li className="py-3">
        <div className="flex items-start justify-between gap-3">
          <p className="font-medium text-fg">Equity</p>
          <div className="text-right">
            <CurrencyAmount agorotValue={agorot(account.equity.ilsAgorot)} nativeValue={nativeAmount(account.equity.usdCents)} currency="USD" />
          </div>
        </div>
      </li>
    </ul>
  );
}
