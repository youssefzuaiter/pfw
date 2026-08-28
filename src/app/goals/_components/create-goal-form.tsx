"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Spinner } from "../../../components/spinner/spinner";

export function CreateGoalForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [targetAmount, setTargetAmount] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !targetAmount.trim()) return;

    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          targetAmount: targetAmount.trim(),
          targetDate: targetDate ? new Date(targetDate).toISOString() : undefined,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to create goal");
      }
      setName("");
      setTargetAmount("");
      setTargetDate("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create goal");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="goal-name" className="text-xs font-medium text-muted">
          Goal name
        </label>
        <input
          id="goal-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Emergency fund"
          className="min-w-[160px] rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="goal-target" className="text-xs font-medium text-muted">
          Target (₪)
        </label>
        <input
          id="goal-target"
          inputMode="decimal"
          value={targetAmount}
          onChange={(event) => setTargetAmount(event.target.value)}
          placeholder="10000.00"
          className="w-32 rounded-md border border-border bg-bg px-3 py-2 font-tabular-figures text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="goal-target-date" className="text-xs font-medium text-muted">
          Target date (optional)
        </label>
        <input
          id="goal-target-date"
          type="date"
          value={targetDate}
          onChange={(event) => setTargetDate(event.target.value)}
          className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <button
        type="submit"
        disabled={isSubmitting || !name.trim() || !targetAmount.trim()}
        className="uv-btn-press flex items-center gap-2 rounded-md border border-border bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {isSubmitting && <Spinner />}
        {isSubmitting ? "Adding…" : "Add goal"}
      </button>
      {error && <p className="text-sm text-negative">{error}</p>}
    </form>
  );
}
