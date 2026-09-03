"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ShareResourceControl } from "../../../components/household/share-resource-control";
import { Spinner } from "../../../components/spinner/spinner";
import { Tickbar, type TickbarStatus } from "../../../components/tickbar/tickbar";

function statusFromUtilization(utilization: number): TickbarStatus {
  if (utilization >= 1) return "critical";
  if (utilization >= 0.8) return "warning";
  return "good";
}

export type EnvelopeRowData = {
  categoryId: string;
  categoryName: string;
  balanceFormatted: string;
  balanceIsNegative: boolean;
  /** Shekel-string, e.g. "220.00" — the allocation input's initial value. */
  allocatedThisMonthValue: string;
  spentThisMonthFormatted: string;
  /** spentThisMonth / allocatedThisMonth, 0 when nothing's allocated yet. */
  utilization: number;
  sharedGroupId: string | null;
};

/**
 * One category's envelope: the ROLLING balance (carries every prior
 * month's leftover/deficit forward — the whole point of zero-sum
 * envelope budgeting) shown prominently, this month's own allocation as
 * an editable input, and this month's own spend/utilization below it —
 * the three figures the task explicitly asked to show side by side.
 */
export function EnvelopeRow({
  envelope,
  month,
  groups,
}: {
  envelope: EnvelopeRowData;
  month: string;
  groups: readonly { id: string; name: string }[];
}) {
  const router = useRouter();
  const [amount, setAmount] = useState(envelope.allocatedThisMonthValue);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/envelopes/allocate", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryId: envelope.categoryId, month, amount }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to update allocation");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update allocation");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <li className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium text-fg">{envelope.categoryName}</p>
          <p
            className={`font-tabular-figures text-lg font-semibold ${envelope.balanceIsNegative ? "text-negative" : "text-positive"}`}
          >
            {envelope.balanceFormatted}
          </p>
          <p className="text-xs text-muted">rolling balance</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <form onSubmit={handleSubmit} className="flex items-center gap-2">
            <label className="sr-only" htmlFor={`allocate-${envelope.categoryId}`}>
              Allocate for {month}
            </label>
            <input
              id={`allocate-${envelope.categoryId}`}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              className="w-28 rounded-md border border-border bg-bg px-2 py-1 text-right text-sm font-tabular-figures text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <button
              type="submit"
              disabled={isSubmitting}
              className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium text-fg hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {isSubmitting && <Spinner />} Save
            </button>
          </form>
          <ShareResourceControl
            resourceType="budget"
            resourceId={envelope.categoryId}
            groups={groups}
            currentSharedGroupId={envelope.sharedGroupId}
          />
        </div>
      </div>
      <div className="mt-3">
        <Tickbar
          label={`${envelope.categoryName} spent this month`}
          percent={envelope.utilization * 100}
          status={statusFromUtilization(envelope.utilization)}
        />
      </div>
      <p className="mt-2 text-xs text-muted">{envelope.spentThisMonthFormatted} spent this month</p>
      {error && <p className="mt-2 text-xs text-negative">{error}</p>}
    </li>
  );
}
