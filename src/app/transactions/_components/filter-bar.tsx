"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import type { TransactionSort } from "../../../server/dal/transactions";

type Category = { id: string; name: string };

const SORT_OPTIONS: Array<{ value: TransactionSort; label: string }> = [
  { value: "date_desc", label: "Newest first" },
  { value: "date_asc", label: "Oldest first" },
  { value: "amount_desc", label: "Amount: high to low" },
  { value: "amount_asc", label: "Amount: low to high" },
];

/**
 * Filters live in the URL (`?q=&category=&sort=`), not client state —
 * the server re-fetches and re-renders on navigation. This means a
 * filtered view is shareable/bookmarkable and survives a reload, and it
 * avoids needing a client-fetched "GET /api/transactions" endpoint at
 * all for what is otherwise a plain read.
 */
export function FilterBar({
  categories,
  initialQuery,
  initialCategoryId,
  initialSort,
}: {
  categories: readonly Category[];
  initialQuery: string;
  initialCategoryId: string;
  initialSort: TransactionSort;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(initialQuery);
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

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateParams({ q: query });
  }

  return (
    <form onSubmit={handleSearchSubmit} role="search" className="flex flex-wrap items-center gap-3">
      <label className="sr-only" htmlFor="transaction-search">
        Search transactions
      </label>
      <input
        id="transaction-search"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search merchant or description…"
        className="min-w-[180px] flex-1 rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />

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

      <button
        type="submit"
        className="rounded-md border border-border px-3 py-2 text-sm font-medium text-fg transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Search
      </button>
    </form>
  );
}
