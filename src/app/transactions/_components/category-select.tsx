"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ChangeEvent } from "react";

type Category = { id: string; name: string };

/**
 * The "inline recategorisation" control. Optimistic: the select updates
 * immediately, then rolls back if the PATCH fails. `router.refresh()`
 * re-fetches the server-rendered list afterward so the rest of the page
 * (category donut, budget status, etc. elsewhere in the app) stays
 * consistent with the change — this component doesn't try to patch
 * those independently.
 */
export function CategorySelect({
  transactionId,
  categoryId,
  categories,
}: {
  transactionId: string;
  categoryId: string;
  categories: readonly Category[];
}) {
  const router = useRouter();
  const [value, setValue] = useState(categoryId);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function handleChange(event: ChangeEvent<HTMLSelectElement>) {
    const nextCategoryId = event.target.value;
    const previousValue = value;
    setValue(nextCategoryId);
    setError(null);

    try {
      const response = await fetch(`/api/transactions/${transactionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryId: nextCategoryId }),
      });
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }
      startTransition(() => {
        router.refresh();
      });
    } catch {
      setValue(previousValue);
      setError("Couldn't update — try again.");
    }
  }

  return (
    <div>
      <label className="sr-only" htmlFor={`category-${transactionId}`}>
        Category
      </label>
      <select
        id={`category-${transactionId}`}
        value={value}
        onChange={handleChange}
        disabled={isPending}
        className="rounded-md border border-border bg-bg px-2 py-1 text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {categories.map((category) => (
          <option key={category.id} value={category.id}>
            {category.name}
          </option>
        ))}
      </select>
      {error && <p className="mt-1 text-xs text-negative">{error}</p>}
    </div>
  );
}
