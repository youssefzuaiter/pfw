"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Spinner } from "../../../../components/spinner/spinner";

type Category = { id: string; name: string };

type Props = {
  /** The ids selected AND currently shown: the only ones an action may touch. */
  selectedIds: readonly string[];
  categories: readonly Category[];
  onClear: () => void;
};

/** The server's own limit; the bar refuses before asking. */
export const MAX_BULK_SELECTION = 500;

type Outcome = { message: string; undoIds?: readonly string[] };

type BulkResponse = { ok: boolean; changed: number; changedIds: string[]; skippedSplit: number; unchanged: number; notFound: number; error?: string };

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The bar that appears once rows are ticked (AGENTS.md §3hhhh): set one
 * category, mark or unmark as transfers, or delete, for all of them in one
 * go. Delete asks to confirm and then offers Undo for exactly the rows it
 * deleted. Everything goes through one all-or-nothing request.
 */
export function BulkActionBar({ selectedIds, categories, onClear }: Props) {
  const router = useRouter();
  const [categoryId, setCategoryId] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const count = selectedIds.length;
  const tooMany = count > MAX_BULK_SELECTION;

  async function send(ids: readonly string[], action: Record<string, unknown>): Promise<BulkResponse | null> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/transactions/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, action }),
      });
      const body = (await response.json().catch(() => ({}))) as BulkResponse;
      if (!response.ok) throw new Error(body.error ?? "Something went wrong. Nothing was changed.");
      return body;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Nothing was changed.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  function describe(body: BulkResponse, verb: string): string {
    const parts = [`${verb} ${plural(body.changed, "transaction")}`];
    if (body.unchanged > 0) parts.push(`${body.unchanged} already ${body.unchanged === 1 ? "was" : "were"} that way`);
    if (body.skippedSplit > 0) parts.push(`${plural(body.skippedSplit, "split transaction")} skipped: edit those in the split editor`);
    if (body.notFound > 0) parts.push(`${body.notFound} not found`);
    return `${parts.join(". ")}.`;
  }

  async function handleSetCategory() {
    if (!categoryId) return;
    const body = await send(selectedIds, { type: "category", categoryId });
    if (!body) return;
    setOutcome({ message: describe(body, "Changed the category of") });
    setCategoryId("");
    onClear();
    router.refresh();
  }

  async function handleTransfer(isTransfer: boolean) {
    const body = await send(selectedIds, { type: "transfer", isTransfer });
    if (!body) return;
    setOutcome({ message: describe(body, isTransfer ? "Marked as transfers:" : "No longer transfers:") });
    onClear();
    router.refresh();
  }

  function handleMarkTransfer() {
    void handleTransfer(true);
  }
  function handleUnmarkTransfer() {
    void handleTransfer(false);
  }
  function handleAskDelete() {
    setConfirmingDelete(true);
  }
  function handleKeep() {
    setConfirmingDelete(false);
  }

  async function handleDelete() {
    const body = await send(selectedIds, { type: "delete" });
    setConfirmingDelete(false);
    if (!body) return;
    setOutcome({ message: describe(body, "Deleted"), undoIds: body.changedIds.length > 0 ? body.changedIds : undefined });
    onClear();
    router.refresh();
  }

  async function handleUndo() {
    if (!outcome?.undoIds) return;
    const body = await send(outcome.undoIds, { type: "restore" });
    if (!body) return;
    setOutcome({ message: describe(body, "Restored") });
    router.refresh();
  }

  function handleDismiss() {
    setOutcome(null);
  }

  function handleCategoryChange(event: React.ChangeEvent<HTMLSelectElement>) {
    setCategoryId(event.target.value);
  }

  return (
    <div className="sticky bottom-24 z-20 flex flex-col gap-2 md:bottom-4">
      {outcome && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface px-4 py-2 text-sm text-fg shadow-lg">
          <span>{outcome.message}</span>
          <span className="flex items-center gap-2">
            {outcome.undoIds && (
              <button
                type="button"
                onClick={handleUndo}
                disabled={busy}
                className="uv-btn-press rounded-md border border-border bg-accent px-3 py-1 text-xs font-medium text-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                {busy ? "…" : "Undo"}
              </button>
            )}
            <button
              type="button"
              onClick={handleDismiss}
              className="rounded-md border border-border px-3 py-1 text-xs font-medium text-muted hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Dismiss
            </button>
          </span>
        </div>
      )}

      {count > 0 && (
        <div role="region" aria-label="Actions for the selected transactions" className="flex flex-wrap items-center gap-2 rounded-lg border border-accent bg-surface px-4 py-3 shadow-lg">
          <span className="text-sm font-medium text-fg">{count} selected</span>
          <button
            type="button"
            onClick={onClear}
            disabled={busy}
            className="rounded-md px-2 py-1.5 text-sm text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            Clear selection
          </button>
          {tooMany && <span className="text-xs text-negative">Select at most {MAX_BULK_SELECTION} at a time.</span>}

          <label className="sr-only" htmlFor="bulk-category">
            Category for the selected transactions
          </label>
          <select
            id="bulk-category"
            value={categoryId}
            onChange={handleCategoryChange}
            disabled={busy || tooMany}
            className="rounded-md border border-border bg-elevated px-2 py-1.5 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">Choose a category…</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleSetCategory}
            disabled={busy || tooMany || !categoryId}
            className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border bg-accent px-3 py-1.5 text-sm font-medium text-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {busy && <Spinner />} Set category
          </button>
          <button
            type="button"
            onClick={handleMarkTransfer}
            disabled={busy || tooMany}
            title="Money between your own accounts: kept in the ledger, left out of income and spending"
            className="rounded-md border border-border bg-elevated px-3 py-1.5 text-sm text-fg hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            Mark as transfer
          </button>
          <button
            type="button"
            onClick={handleUnmarkTransfer}
            disabled={busy || tooMany}
            className="rounded-md border border-border bg-elevated px-3 py-1.5 text-sm text-muted hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            Not a transfer
          </button>

          {confirmingDelete ? (
            <span className="flex items-center gap-2">
              <span className="text-sm text-fg">Delete {plural(count, "transaction")}?</span>
              <button
                type="button"
                onClick={handleDelete}
                disabled={busy || tooMany}
                className="uv-btn-press rounded-md border border-border px-3 py-1.5 text-sm font-medium text-negative hover:bg-negative/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                Yes, delete
              </button>
              <button
                type="button"
                onClick={handleKeep}
                disabled={busy}
                className="rounded-md border border-border px-3 py-1.5 text-sm text-fg hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                Keep
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={handleAskDelete}
              disabled={busy || tooMany}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-negative hover:bg-negative/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              Delete
            </button>
          )}

          {error && (
            <p role="alert" className="w-full text-sm text-negative">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
