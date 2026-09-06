"use client";

import { WifiOff } from "lucide-react";

/**
 * The PWA offline fallback (Phase 4, ad hoc) — `public/sw.js` serves
 * this exact page's cached response whenever a full-page navigation
 * fails with no network. Deliberately static: no `getCurrentUser()`, no
 * DAL call, nothing that could itself fail while offline or that would
 * go stale sitting in the service worker's cache since install time.
 * Public (`src/proxy.ts`'s `PUBLIC_EXACT_PATHS`) for the same reason —
 * the service worker precaches this at install time, which can happen
 * before the visitor has ever signed in.
 */
function handleRetry() {
  window.location.reload();
}

export default function OfflinePage() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-24 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/10 text-accent">
        <WifiOff className="h-7 w-7" aria-hidden="true" />
      </div>
      <h1 className="font-display text-xl font-semibold text-fg">You&rsquo;re offline</h1>
      <p className="text-sm text-muted">
        PFW couldn&rsquo;t reach the network. Your budgets, balances, and transactions need a live connection to
        load — nothing here is ever shown from a stale cache.
      </p>
      <button
        type="button"
        onClick={handleRetry}
        className="mt-2 rounded-md border border-border bg-accent px-4 py-2 text-sm font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Try again
      </button>
    </div>
  );
}
