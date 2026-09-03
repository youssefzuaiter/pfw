"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ToggleSwitch } from "../../../../components/toggle/toggle-switch";

/**
 * Note for anyone editing this file: prefer a named handler over an
 * inline arrow function on a button element — an inline `() => ...`
 * contains a literal `>` from `=>` that confuses
 * tests/guards/focus-visible.test.ts's regex-based tag scanner.
 */
export function RuleRowActions({ rule }: { rule: { id: string; isActive: boolean } }) {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleToggle(checked: boolean) {
    setIsPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/transaction-rules/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: checked }),
      });
      if (!response.ok) throw new Error("Request failed");
      router.refresh();
    } catch {
      setError("Something went wrong — try again.");
    } finally {
      setIsPending(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm("Delete this rule? It will no longer run on future transactions.")) return;

    setIsPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/transaction-rules/${rule.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Request failed");
      router.refresh();
    } catch {
      setError("Something went wrong — try again.");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <ToggleSwitch
        id={`rule-active-${rule.id}`}
        checked={rule.isActive}
        onChange={handleToggle}
        label={rule.isActive ? "Active" : "Inactive"}
      />
      <button
        type="button"
        onClick={handleDelete}
        disabled={isPending}
        className="uv-btn-press rounded-md border border-border px-2 py-1 text-xs font-medium text-negative hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        Delete
      </button>
      {error && <span className="text-xs text-negative">{error}</span>}
    </div>
  );
}
