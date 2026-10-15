import { ReportingFlowAmount } from "../../../../components/currency/reporting-currency-provider";
import type { CurrencyCode } from "../../../../lib/currency";
import type { Agorot } from "../../../../lib/money";
import { CategorySelect } from "./category-select";
import { LedgerHistoryModal } from "./ledger-history-modal";
import { SplitEditorModal, type SplitView } from "./split-editor-modal";
import { TransactionRowActions } from "./transaction-row-actions";

export type TransactionRow = {
  id: string;
  occurredAt: Date;
  description: string;
  merchantName: string | null;
  amount: Agorot;
  categoryId: string;
  categoryName: string;
  needsReview: boolean;
  /** Money between the user's own accounts — shown, but left out of earned/spent figures. */
  isTransfer: boolean;
  /** The currency the transaction happened in, and its amount there (minor units). */
  currency: CurrencyCode;
  nativeAmount: number;
  /** How the amount divides across categories; empty when it is in one (AGENTS.md §3xxx). */
  splits: readonly SplitView[];
};

type Category = { id: string; name: string; isUncategorized?: boolean };

/**
 * The category control for one row: a split row shows its categories and
 * opens the split editor; any other row keeps the one-category picker, plus
 * a Split button unless it is a transfer (which has nothing to divide).
 */
function CategoryCell({ row, categories }: { row: TransactionRow; categories: readonly Category[] }) {
  const label = row.merchantName ?? row.description;
  const splitCategories = categories.filter((category) => !category.isUncategorized);
  const editor = (triggerLabel: string) => (
    <SplitEditorModal
      transactionId={row.id}
      label={label}
      currency={row.currency}
      nativeTotal={row.nativeAmount}
      categoryId={row.categoryId}
      splits={row.splits}
      categories={splitCategories}
      triggerLabel={triggerLabel}
    />
  );
  if (row.splits.length > 0) {
    const names = [...row.splits]
      .sort((a, b) => Math.abs(b.amountAgorot) - Math.abs(a.amountAgorot))
      .map((split) => split.categoryName)
      .join(", ");
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <span className="text-sm text-fg">Split: {names}</span>
        {editor("Edit split")}
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <CategorySelect transactionId={row.id} categoryId={row.categoryId} categories={categories} merchantText={label} />
      {!row.isTransfer && editor("Split")}
    </span>
  );
}

/** At the rate of the transaction's own day (AGENTS.md §3vvv), or exact when it happened in the reporting currency. */
function AmountCell({ row }: { row: TransactionRow }) {
  return (
    <span className={`font-tabular-figures font-medium tracking-tight ${row.amount < 0 ? "text-fg" : "text-positive"}`}>
      <ReportingFlowAmount amount={row.amount} occurredAt={row.occurredAt} currency={row.currency} nativeAmount={row.nativeAmount} />
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
              <th scope="col" className="px-4 py-2 font-medium">
                <span className="sr-only">History</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} data-transaction-id={row.id} className="border-b border-border last:border-0">
                <td className="whitespace-nowrap px-4 py-2 font-tabular-figures tracking-tight text-muted">
                  {row.occurredAt.toISOString().slice(0, 10)}
                </td>
                <td className="px-4 py-2">
                  <p className="font-medium text-fg">{row.merchantName ?? row.description}</p>
                  {row.needsReview && <span className="text-xs text-signature">Needs review</span>}
                </td>
                <td className="px-4 py-2">
                  <CategoryCell row={row} categories={categories} />
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-right">
                  <AmountCell row={row} />
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-right">
                  <span className="inline-flex items-center gap-1">
                    <LedgerHistoryModal transactionId={row.id} label={row.merchantName ?? row.description} />
              <TransactionRowActions transactionId={row.id} isTransfer={row.isTransfer} />
                    <TransactionRowActions transactionId={row.id} isTransfer={row.isTransfer} />
                  </span>
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
                <p className="font-tabular-figures text-xs tracking-tight text-muted">
                  {row.occurredAt.toISOString().slice(0, 10)}
                </p>
              </div>
              <AmountCell row={row} />
            </div>
            {row.needsReview && <p className="mt-1 text-xs text-signature">Needs review</p>}
            <div className="mt-2 flex items-center justify-between gap-2">
              <CategoryCell row={row} categories={categories} />
              <LedgerHistoryModal transactionId={row.id} label={row.merchantName ?? row.description} />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
