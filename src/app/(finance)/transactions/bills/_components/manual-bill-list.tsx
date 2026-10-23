"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "../../../../../components/badge/badge";
import { Spinner } from "../../../../../components/spinner/spinner";
import { KIND_WORDS, RecurringBillForm, type CadenceValue, type EditableBill } from "./recurring-bill-form";

const CADENCE_LABEL: Record<CadenceValue, string> = {
  monthly: "month",
  quarterly: "3 months",
  annual: "year",
};

export type ManualBillItem = EditableBill & {
  /** The amount it is expected to cost: for a varying bill, the average of its last payments. */
  formattedAmount: string;
  /** For a varying bill, how many real payments that was averaged from; 0 means it is still the typed amount. */
  estimateBasedOnPayments: number;
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
        throw new Error(body.error ?? `Failed to delete the ${KIND_WORDS[item.kind].noun}`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to delete the ${KIND_WORDS[item.kind].noun}`);
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
          {item.detectedAs && <Badge variant="neutral">Now in your statements</Badge>}
        </p>
        <p className="font-tabular-figures text-sm tracking-tight text-muted">
          {item.amountVaries && "about "}
          {item.formattedAmount} / {CADENCE_LABEL[item.cadence]}
          {item.categoryName && ` — ${item.categoryName}`}
          {item.nextDueDate && ` — next due ${item.nextDueDate}`}
        </p>
        {item.amountVaries && (
          <p className="text-xs text-muted">
            Different every time:{" "}
            {item.estimateBasedOnPayments > 0
              ? `the average of its last ${item.estimateBasedOnPayments} ${item.estimateBasedOnPayments === 1 ? "payment" : "payments"}.`
              : "using the typical amount you entered until a payment appears in your statements."}
          </p>
        )}
        {item.detectedAs && (
          <p className="text-xs text-muted">
            Your statements now show this as &ldquo;{item.detectedAs}&rdquo;, so that one is counted (on the Subscriptions page) and this entry is not, to avoid
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

/** The bills or subscriptions the user typed in, with edit and delete (AGENTS.md §3cccc, §3eeee). */
export function ManualBillList({ items, categories }: { items: readonly ManualBillItem[]; categories: readonly Category[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <ManualBillRow key={item.id} item={item} categories={categories} />
      ))}
    </ul>
  );
}
