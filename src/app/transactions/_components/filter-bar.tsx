"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import type { TransactionSort } from "../../../server/dal/transactions";

type Category = { id: string; name: string };

const SORT_OPTIONS: Array<{ value: TransactionSort; label: string }> = [
  { value: "date_desc", label: "Newest first" },
  { value: "date_asc", label: "Oldest first" },
  { value: "amount_desc", label: "Amount: high to low" },
  { value: "amount_asc", label: "Amount: low to high" },
];

/**
 * Category/sort only now (AGENTS.md §3cc) — the free-text search box
 * moved to `TransactionsExplorer`, which drives it client-side through
 * `POST /api/transactions/search` rather than a `?q=` URL param, since
 * computing a query embedding needs the browser. These two filters stay
 * exactly as before: live in the URL, the server re-fetches and
 * re-renders on navigation, so a category/sort selection is still
 * shareable/bookmarkable and survives a reload.
 */
export function FilterBar({
  categories,
  initialCategoryId,
  initialSort,
}: {
  categories: readonly Category[];
  initialCategoryId: string;
  initialSort: TransactionSort;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  function updateParams(next: Record<string, string>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
    }
    startTransition(() => {
      router.push(params.size > 0 ? `${pathname}?${params.toString()}` : pathname);
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="sr-only" htmlFor="transaction-category-filter">
        Filter by category
      </label>
      <select
        id="transaction-category-filter"
        value={initialCategoryId}
        onChange={(event) => updateParams({ category: event.target.value })}
        className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <option value="">All categories</option>
        {categories.map((category) => (
          <option key={category.id} value={category.id}>
            {category.name}
          </option>
        ))}
      </select>

      <label className="sr-only" htmlFor="transaction-sort">
        Sort
      </label>
      <select
        id="transaction-sort"
        value={initialSort}
        onChange={(event) => updateParams({ sort: event.target.value })}
        className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {SORT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
