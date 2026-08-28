import { formatAgorot, type Agorot } from "../../../lib/money";
import { CategorySelect } from "./category-select";

export type TransactionRow = {
  id: string;
  occurredAt: Date;
  description: string;
  merchantName: string | null;
  amount: Agorot;
  categoryId: string;
  categoryName: string;
  needsReview: boolean;
};

type Category = { id: string; name: string };

function AmountCell({ amount }: { amount: Agorot }) {
  return (
    <span className={`font-tabular-figures font-medium ${amount < 0 ? "text-fg" : "text-positive"}`}>
      {formatAgorot(amount)}
    </span>
  );
}

export function TransactionsTable({
  rows,
  categories,
}: {
  rows: readonly TransactionRow[];
  categories: readonly Category[];
}) {
  if (rows.length === 0) {
    return <p className="p-6 text-center text-sm text-muted">No transactions match your filters.</p>;
  }

  return (
    <>
      <div className="hidden overflow-x-auto rounded-lg border border-border bg-surface md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <th scope="col" className="px-4 py-2 font-medium">
                Date
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Description
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Category
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-border last:border-0">
                <td className="whitespace-nowrap px-4 py-3 font-tabular-figures text-muted">
                  {row.occurredAt.toISOString().slice(0, 10)}
                </td>
                <td className="px-4 py-3">
                  <p className="font-medium text-fg">{row.merchantName ?? row.description}</p>
                  {row.needsReview && <span className="text-xs text-signature">Needs review</span>}
                </td>
                <td className="px-4 py-3">
                  <CategorySelect transactionId={row.id} categoryId={row.categoryId} categories={categories} />
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right">
                  <AmountCell amount={row.amount} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-col gap-3 md:hidden">
        {rows.map((row) => (
          <li key={row.id} className="rounded-lg border border-border bg-surface p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-medium text-fg">{row.merchantName ?? row.description}</p>
                <p className="font-tabular-figures text-xs text-muted">{row.occurredAt.toISOString().slice(0, 10)}</p>
              </div>
              <AmountCell amount={row.amount} />
            </div>
            {row.needsReview && <p className="mt-1 text-xs text-signature">Needs review</p>}
            <div className="mt-2">
              <CategorySelect transactionId={row.id} categoryId={row.categoryId} categories={categories} />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
