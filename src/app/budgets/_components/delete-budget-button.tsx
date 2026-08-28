"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Spinner } from "../../../components/spinner/spinner";

export function DeleteBudgetButton({ budgetId }: { budgetId: string }) {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);

  async function handleClick() {
    if (!window.confirm("Remove this budget?")) return;
    setIsPending(true);
    try {
      const response = await fetch(`/api/budgets/${budgetId}`, { method: "DELETE" });
      if (response.ok) router.refresh();
    } finally {
      setIsPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isPending}
      className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border px-3 py-1 text-xs font-medium text-negative transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      {isPending && <Spinner />}
      Remove
    </button>
  );
}
