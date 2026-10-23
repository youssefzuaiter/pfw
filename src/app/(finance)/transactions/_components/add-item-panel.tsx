"use client";

import { useState } from "react";
import { KIND_WORDS, RecurringBillForm, type ItemKind } from "../bills/_components/recurring-bill-form";

/**
 * The Add button on the Subscriptions page and the Bills page (AGENTS.md
 * §3ffff). It opens the form for that page's own kind, and closes it again
 * once the item is saved, so adding never takes the user off the page.
 */
export function AddItemPanel({
  kind,
  categories,
  help,
}: {
  kind: ItemKind;
  categories: readonly { id: string; name: string }[];
  help: string;
}) {
  const [open, setOpen] = useState(false);
  const words = KIND_WORDS[kind];
  const panelId = `add-${kind}-panel`;

  function handleToggle() {
    setOpen((current) => !current);
  }
  function handleDone() {
    setOpen(false);
  }

  return (
    <section aria-label={`Add a ${words.noun}`} className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">{help}</p>
        <button
          type="button"
          onClick={handleToggle}
          aria-expanded={open}
          aria-controls={panelId}
          className="uv-btn-press rounded-md border border-border bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {open ? "Close" : `+ Add ${words.noun}`}
        </button>
      </div>
      {open && (
        <div id={panelId} className="mt-4 border-t border-border pt-4">
          <RecurringBillForm categories={categories} kind={kind} onDone={handleDone} />
        </div>
      )}
    </section>
  );
}
