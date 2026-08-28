"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Spinner } from "../../../components/spinner/spinner";

const DEBT_TYPES = [
  { value: "CREDIT_CARD", label: "Credit card" },
  { value: "MORTGAGE", label: "Mortgage" },
  { value: "PERSONAL_LOAN", label: "Personal loan" },
  { value: "AUTO_LOAN", label: "Auto loan" },
  { value: "STUDENT_LOAN", label: "Student loan" },
  { value: "OTHER", label: "Other" },
] as const;

export function CreateDebtForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [debtType, setDebtType] = useState<(typeof DEBT_TYPES)[number]["value"]>("CREDIT_CARD");
  const [currentBalance, setCurrentBalance] = useState("");
  const [aprPercent, setAprPercent] = useState("");
  const [minimumPayment, setMinimumPayment] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !currentBalance.trim() || !aprPercent.trim() || !minimumPayment.trim()) return;

    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/debts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          debtType,
          currentBalance: currentBalance.trim(),
          aprPercent: aprPercent.trim(),
          minimumPayment: minimumPayment.trim(),
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to add debt");
      }
      setName("");
      setCurrentBalance("");
      setAprPercent("");
      setMinimumPayment("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add debt");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="debt-name" className="text-xs font-medium text-muted">
          Name
        </label>
        <input
          id="debt-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="חוב כרטיס אשראי"
          className="min-w-[160px] rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="debt-type" className="text-xs font-medium text-muted">
          Type
        </label>
        <select
          id="debt-type"
          value={debtType}
          onChange={(event) => setDebtType(event.target.value as (typeof DEBT_TYPES)[number]["value"])}
          className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {DEBT_TYPES.map((type) => (
            <option key={type.value} value={type.value}>
              {type.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="debt-balance" className="text-xs font-medium text-muted">
          Balance (₪)
        </label>
        <input
          id="debt-balance"
          inputMode="decimal"
          value={currentBalance}
          onChange={(event) => setCurrentBalance(event.target.value)}
          placeholder="5000.00"
          className="w-28 rounded-md border border-border bg-bg px-3 py-2 font-tabular-figures text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="debt-apr" className="text-xs font-medium text-muted">
          APR (%)
        </label>
        <input
          id="debt-apr"
          inputMode="decimal"
          value={aprPercent}
          onChange={(event) => setAprPercent(event.target.value)}
          placeholder="19.90"
          className="w-20 rounded-md border border-border bg-bg px-3 py-2 font-tabular-figures text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="debt-min-payment" className="text-xs font-medium text-muted">
          Min. payment (₪)
        </label>
        <input
          id="debt-min-payment"
          inputMode="decimal"
          value={minimumPayment}
          onChange={(event) => setMinimumPayment(event.target.value)}
          placeholder="300.00"
          className="w-28 rounded-md border border-border bg-bg px-3 py-2 font-tabular-figures text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <button
        type="submit"
        disabled={isSubmitting}
        className="uv-btn-press flex items-center gap-2 rounded-md border border-border bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {isSubmitting && <Spinner />}
        {isSubmitting ? "Adding…" : "Add debt"}
      </button>
      {error && <p className="w-full text-sm text-negative">{error}</p>}
    </form>
  );
}
