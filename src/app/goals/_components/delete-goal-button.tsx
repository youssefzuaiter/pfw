"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Spinner } from "../../../components/spinner/spinner";

/**
 * Note for anyone editing this file: prefer a named handler over an
 * inline arrow function on a button element — an inline `() => ...`
 * contains a literal `>` from `=>` that confuses
 * tests/guards/focus-visible.test.ts's regex-based tag scanner.
 */
export function DeleteGoalButton({ goalId, goalName }: { goalId: string; goalName: string }) {
  const router = useRouter();
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    if (!window.confirm(`Delete "${goalName}"? This removes the goal and its entire contribution history.`)) return;

    setIsDeleting(true);
    setError(null);
    try {
      const response = await fetch(`/api/goals/${goalId}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Request failed");
      router.refresh();
    } catch {
      setError("Something went wrong — try again.");
      setIsDeleting(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleDelete}
        disabled={isDeleting}
        className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium text-negative hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {isDeleting && <Spinner />} Delete
      </button>
      {error && <span className="text-xs text-negative">{error}</span>}
    </div>
  );
}
