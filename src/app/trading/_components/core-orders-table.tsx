import { Badge, type BadgeVariant } from "../../../components/badge/badge";
import { formatUsdDecimal } from "../../../lib/core-format";
import { formatDecimalTrimmed } from "../../../lib/decimal-string";
import type { CorePlanOrder } from "../../../lib/core-journal";

function orderVariant(status: string): BadgeVariant {
  if (status === "filled") return "positive";
  if (status === "rejected") return "critical";
  if (status === "canceled" || status === "expired") return "warning";
  return "neutral";
}

function amountOf(order: CorePlanOrder): string {
  if (order.notionalUsd) return formatUsdDecimal(order.notionalUsd);
  if (order.qty) return `${formatDecimalTrimmed(order.qty, 6)} sh`;
  return "—";
}

function filledOf(order: CorePlanOrder): string {
  if (!order.filledQty || !order.filledAvgPrice || !/[1-9]/.test(order.filledQty)) return "—";
  return `${formatDecimalTrimmed(order.filledQty, 6)} sh @ ${formatUsdDecimal(order.filledAvgPrice)}`;
}

/** The orders a plan sent, with what each one filled. Text from the router is rendered as text, never as markup. */
export function CoreOrdersTable({ orders }: { orders: CorePlanOrder[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[26rem] border-collapse text-sm">
        <caption className="sr-only">Orders sent for this plan, with their status and what each filled</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <th scope="col" className="pb-2 pr-3 font-medium">Order</th>
            <th scope="col" className="pb-2 pr-3 text-right font-medium">Amount</th>
            <th scope="col" className="pb-2 text-right font-medium">Filled</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <tr key={order.clientOrderId} className="border-b border-border last:border-b-0">
              <td className="py-2 pr-3 text-fg">
                <span className="capitalize">{order.side}</span> {order.symbol}
                <span className="mt-1 block">
                  <Badge variant={orderVariant(order.status)}>{order.status}</Badge>
                </span>
                {order.error && <span className="mt-1 block text-xs text-negative">{order.error}</span>}
              </td>
              <td className="py-2 pr-3 text-right font-tabular-figures text-fg">{amountOf(order)}</td>
              <td className="py-2 text-right font-tabular-figures text-fg">{filledOf(order)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
