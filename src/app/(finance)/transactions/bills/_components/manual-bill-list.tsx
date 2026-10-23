"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "../../../../../components/badge/badge";
import { Spinner } from "../../../../../components/spinner/spinner";
import { RecurringBillForm, type CadenceValue, type EditableBill } from "./recurring-bill-form";

const CADENCE_LABEL: Record<CadenceValue, string> = {
  monthly: "month",
  quarterly: "3 months",
  annual: "year",
};

export type ManualBillItem = EditableBill & {
  formattedAmount: string;
  categoryName: string | null;
  nextDueDate: string | null;
  detectedAs: string | null;
  status: "ACTIVE" | "REVIEWED" | "CANCELLED";
};

type Category = { id: string; name: string };

function ManualBillRow({ item, categories }: { item: ManualBillItem; categories: readonly Category[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleEdit() {
    setEditing(true);
  }
  function handleStopEditing() {
    setEditing(false);
  }
  function handleAskDelete() {
    setConfirming(true);
  }
  function handleKeep() {
    setConfirming(false);
  }

  async function handleDelete() {
    setIsDeleting(true);
    setError(null);
    try {
      const response = await fetch(`/api/recurring-bills/${item.id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to delete the bill");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete the bill");
      setIsDeleting(false);
    }
  }

  if (editing) {
    return (
      <li className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
        <RecurringBillForm bill={item} categories={categories} onDone={handleStopEditing} />
        <div>
          <button type="button" onClick={handleStopEditing} className="uv-btn-press rounded-md border border-border px-2 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 text-muted hover:bg-elevated-hover">
            Cancel editing
          </button>
        </div>
      </li>
    );
  }

  return (
    <li
      className={`flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0 ${
        item.status === "CANCELLED" ? "opacity-60" : ""
      }`}
    >
      <div>
        <p className="flex flex-wrap items-center gap-2 font-medium text-fg">
          {item.name}
          {item.status === "CANCELLED" && <Badge variant="critical">CANCELLED</Badge>}
          {item.detectedAs && <Badge variant="neutral">Detected from statements</Badge>}
        </p>
        <p className="font-tabular-figures text-sm tracking-tight text-muted">
          {item.formattedAmount} / {CADENCE_LABEL[item.cadence]}
          {item.categoryName && ` — ${item.categoryName}`}
          {item.nextDueDate && ` — next due ${item.nextDueDate}`}
        </p>
        {item.detectedAs && (
          <p className="text-xs text-muted">
            Your statements now show this as &ldquo;{item.detectedAs}&rdquo;, so that one is counted and this entry is not, to avoid
            counting it twice.
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-negative">
            {error}
          </p>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        {confirming ? (
          <>
            <span className="text-xs text-muted">Delete {item.name}?</span>
            <button
              type="button"
              onClick={handleDelete}
              disabled={isDeleting}
              className="uv-btn-press rounded-md border border-border px-2 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 text-negative hover:bg-negative/10"
            >
              {isDeleting && <Spinner />} Yes, delete
            </button>
            <button type="button" onClick={handleKeep} disabled={isDeleting} className="uv-btn-press rounded-md border border-border px-2 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 text-fg hover:bg-elevated-hover">
              Keep
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={handleEdit} className="uv-btn-press rounded-md border border-border px-2 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 text-fg hover:bg-elevated-hover">
              Edit
            </button>
            <button type="button" onClick={handleAskDelete} className="uv-btn-press rounded-md border border-border px-2 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 text-negative hover:bg-negative/10">
              Delete
            </button>
          </>
        )}
      </div>
    </li>
  );
}

/** The subscriptions and bills the user typed in, with edit and delete (AGENTS.md §3cccc). */
export function ManualBillList({ items, categories }: { items: readonly ManualBillItem[]; categories: readonly Category[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <ManualBillRow key={item.id} item={item} categories={categories} />
      ))}
    </ul>
  );
}
