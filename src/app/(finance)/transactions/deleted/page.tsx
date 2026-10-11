import Link from "next/link";
import { agorot, formatAgorot } from "../../../../lib/money";
import { getCurrentUser } from "../../../../server/auth/current-user";
import { DELETED_LIST_LIMIT, listDeletedTransactions } from "../../../../server/dal/transactions";
import { RestoreButton } from "./_components/restore-button";

export const instant = false;

function isoDate(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : "";
}

/**
 * Recently deleted — every soft-deleted transaction, with a way back.
 *
 * Delete is soft (AGENTS.md §3ccc), but until this screen the only way to
 * undo one was the button that appears in the row right after deleting it;
 * navigate away and the row was stranded. A deleted import was worse: 211
 * rows restorable only one at a time, from nowhere. Reachable by direct
 * link from `/transactions`, not one of `PRIMARY_NAV_ITEMS`, the same
 * sub-view pattern as `/transactions/rules`.
 */
export default async function RecentlyDeletedPage() {
  const user = await getCurrentUser();
  const { rows, truncated, batches } = await listDeletedTransactions(user.id);

  // A banner for an import only when restoring it is worth a button of its
  // own; one or two stray rows have their own Restore below.
  const importBanners = batches.filter((batch) => batch.count >= 2).sort(
    (a, b) => (b.deletedAt?.getTime() ?? 0) - (a.deletedAt?.getTime() ?? 0),
  );

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-4 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-fg">Recently deleted</h1>
          <p className="mt-1 text-sm text-muted">
            Deleted transactions are kept, not erased. They are left out of every total until you restore them.
          </p>
        </div>
        <Link
          href="/transactions"
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted hover:bg-elevated-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          ← Transactions
        </Link>
      </div>

      {importBanners.map((batch) => (
        <section
          key={batch.importBatchId}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-4"
        >
          <div>
            <h2 className="text-sm font-medium text-fg">Statement import · {batch.count} rows deleted</h2>
            <p className="mt-0.5 text-xs text-muted">Deleted {isoDate(batch.deletedAt)}. Restore the whole import at once.</p>
          </div>
          <RestoreButton
            path={`/api/transactions/import-batch/${batch.importBatchId}/restore`}
            label={`Restore all ${batch.count}`}
            variant="batch"
          />
        </section>
      ))}

      <section className="rounded-lg border border-border bg-surface">
        {rows.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted">Nothing has been deleted.</p>
        ) : (
          <ul>
            {rows.map((row) => {
              const amount = agorot(Number(row.amount));
              const account = row.bankAccount.nickname ?? row.bankAccount.institutionName;
              return (
                <li
                  key={row.id}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-4 py-3 last:border-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-fg">{row.merchantName ?? row.description}</p>
                    <p className="text-xs text-muted">
                      <span className="font-tabular-figures tracking-tight">{isoDate(row.occurredAt)}</span>
                      {" · "}
                      {row.category.name}
                      {" · "}
                      {account}
                      {" · deleted "}
                      <span className="font-tabular-figures tracking-tight">{isoDate(row.deletedAt)}</span>
                    </p>
                  </div>
                  <span
                    className={`font-tabular-figures font-medium tracking-tight ${amount < 0 ? "text-fg" : "text-positive"}`}
                  >
                    {formatAgorot(amount)}
                  </span>
                  <RestoreButton path={`/api/transactions/${row.id}/delete`} body={{ deleted: false }} label="Restore" />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {truncated && (
        <p className="text-xs text-muted">
          Showing the {DELETED_LIST_LIMIT} most recently deleted. Restore some to see older ones.
        </p>
      )}
    </div>
  );
}
