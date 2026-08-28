import { agorot } from "../../lib/money";
import { getCurrentUser } from "../../server/auth/current-user";
import { listBankAccounts } from "../../server/dal/bank-accounts";
import { listCategories } from "../../server/dal/categories";
import { listTransactions, type TransactionSort } from "../../server/dal/transactions";
import { FilterBar } from "./_components/filter-bar";
import { ImportCsvForm } from "./_components/import-csv-form";
import { TransactionsTable, type TransactionRow } from "./_components/transactions-table";

export const instant = false;

const VALID_SORTS: readonly TransactionSort[] = ["date_desc", "date_asc", "amount_desc", "amount_asc"];

function parseSort(value: string | undefined): TransactionSort {
  return (VALID_SORTS as readonly string[]).includes(value ?? "") ? (value as TransactionSort) : "date_desc";
}

function firstString(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = firstString(params.q);
  const categoryId = firstString(params.category);
  const sort = parseSort(firstString(params.sort) || undefined);

  const user = await getCurrentUser();
  const [transactions, categories, bankAccounts] = await Promise.all([
    listTransactions(user.id, {
      search: query || undefined,
      categoryId: categoryId || undefined,
      sort,
    }),
    listCategories(user.id),
    listBankAccounts(user.id),
  ]);

  const categoryOptions = categories.map((c) => ({ id: c.id, name: c.name }));
  const accountOptions = bankAccounts.map((account) => ({
    id: account.id,
    label: account.nickname
      ? `${account.nickname} — ${account.institutionName}`
      : `${account.institutionName} ••${account.last4}`,
  }));

  const rows: TransactionRow[] = transactions.map((t) => ({
    id: t.id,
    occurredAt: t.occurredAt,
    description: t.description,
    merchantName: t.merchantName,
    amount: agorot(Number(t.amount)),
    categoryId: t.categoryId,
    categoryName: t.category.name,
    needsReview: t.needsReview,
  }));

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 md:px-6">
      <h1 className="font-display text-2xl font-semibold text-fg">Transactions</h1>
      <ImportCsvForm bankAccounts={accountOptions} />
      <FilterBar categories={categoryOptions} initialQuery={query} initialCategoryId={categoryId} initialSort={sort} />
      <TransactionsTable rows={rows} categories={categoryOptions} />
    </div>
  );
}
