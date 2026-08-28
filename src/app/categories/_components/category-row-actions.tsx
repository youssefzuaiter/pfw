"use client";

import { useRouter } from "next/navigation";
import { useState, type ChangeEvent } from "react";

type Category = {
  id: string;
  name: string;
  isUncategorized: boolean;
  archivedAt: Date | null;
};

/**
 * Note for anyone editing this file: prefer a named handler over an
 * inline arrow function on a button or anchor element — an inline
 * `() => ...` contains a literal `>` from `=>` that confuses
 * tests/guards/focus-visible.test.ts's regex-based tag scanner. See that
 * guard's own comment for the full story (a real false positive it hit
 * once already, in mobile-nav.tsx).
 */
export function CategoryRowActions({ category }: { category: Category }) {
  const router = useRouter();
  const [isRenaming, setIsRenaming] = useState(false);
  const [name, setName] = useState(category.name);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function patchCategory(body: Record<string, unknown>) {
    setIsPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/categories/${category.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("Request failed");
      router.refresh();
    } catch {
      setError("Something went wrong — try again.");
    } finally {
      setIsPending(false);
    }
  }

  function handleNameChange(event: ChangeEvent<HTMLInputElement>) {
    setName(event.target.value);
  }

  function startRenaming() {
    setIsRenaming(true);
  }

  async function saveRename() {
    setIsRenaming(false);
    if (name.trim() && name.trim() !== category.name) {
      await patchCategory({ name: name.trim() });
    }
  }

  async function toggleArchive() {
    await patchCategory({ archived: !category.archivedAt });
  }

  async function handleDelete() {
    if (!window.confirm(`Delete "${category.name}"? Its transactions will move to Uncategorized.`)) return;

    setIsPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/categories/${category.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Request failed");
      router.refresh();
    } catch {
      setError("Something went wrong — try again.");
    } finally {
      setIsPending(false);
    }
  }

  if (category.isUncategorized) {
    return <span className="text-xs text-muted">Permanent category</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {isRenaming ? (
        <>
          <label className="sr-only" htmlFor={`rename-${category.id}`}>
            Rename category
          </label>
          <input
            id={`rename-${category.id}`}
            value={name}
            onChange={handleNameChange}
            autoFocus
            className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="button"
            onClick={saveRename}
            disabled={isPending}
            className="uv-btn-press rounded-md border border-border px-2 py-1 text-xs font-medium text-fg hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            Save
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={startRenaming}
          disabled={isPending}
          className="uv-btn-press rounded-md border border-border px-2 py-1 text-xs font-medium text-fg hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          Rename
        </button>
      )}
      <button
        type="button"
        onClick={toggleArchive}
        disabled={isPending}
        className="uv-btn-press rounded-md border border-border px-2 py-1 text-xs font-medium text-fg hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {category.archivedAt ? "Unarchive" : "Archive"}
      </button>
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
