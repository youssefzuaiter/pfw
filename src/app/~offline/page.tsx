"use client";

import { useSyncExternalStore } from "react";
import { RefreshCw, Wifi, WifiOff } from "lucide-react";
import { Badge } from "../../components/badge/badge";

/**
 * The PWA offline fallback (Phase 4, ad hoc; polished for live-demo
 * resilience — see `public/sw.js`'s own updated doc comment). Served by
 * `public/sw.js` whenever a full-page navigation fails with no network.
 * Deliberately static: no `getCurrentUser()`, no DAL call, nothing that
 * could itself fail while offline or that would go stale sitting in the
 * service worker's cache since install time.
 *
 * This screen intentionally shows NO cached financial data, even though
 * it's meant to soften a dropped-Wi-Fi moment (e.g. a trade-show booth) —
 * this app's standing rule that no financial figure is ever presented as
 * current when it might be stale applies here exactly as it does
 * everywhere else (see `sw.js`). What IS shown: a clean, branded,
 * honestly-worded "Offline Mode" state instead of the browser's own
 * generic connection-error page, plus automatic detection of the
 * connection coming back (the `online` event) so a recovered Wi-Fi
 * connection mid-demo doesn't require the presenter to guess when to
 * retry.
 *
 * Public (`src/proxy.ts`'s `PUBLIC_EXACT_PATHS`) for the same reason as
 * before — the service worker precaches this at install time, which can
 * happen before the visitor has ever signed in.
 */
function handleRetry() {
  window.location.reload();
}

/**
 * `useSyncExternalStore`, not `useEffect` + `setState` — the same
 * reasoning `useCurrencyDisplayMode` already establishes for syncing to
 * a browser-only source of truth (AGENTS.md §3c): it avoids a
 * synchronous `setState` call in an effect body (the
 * `react-hooks/set-state-in-effect` trap this app's history has hit and
 * fixed several times) and needs no cleanup-timing reasoning of its own.
 */
function subscribeToOnlineStatus(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

function getOnlineSnapshot() {
  return navigator.onLine;
}

// This page is only ever reached client-side (a service-worker fallback
// or a direct offline visit), so the server snapshot's value barely
// matters — `false` avoids a flash of "Back online" before hydration
// confirms the real state.
function getServerOnlineSnapshot() {
  return false;
}

export default function OfflinePage() {
  const isBackOnline = useSyncExternalStore(subscribeToOnlineStatus, getOnlineSnapshot, getServerOnlineSnapshot);

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 bg-bg px-4 py-24 text-center text-fg">
      {/* eslint-disable-next-line @next/next/no-img-element -- a service-worker-precached static asset (public/sw.js), not something Next's image optimizer can process offline */}
      <img src="/icons/icon-192.png" alt="" width={64} height={64} className="rounded-xl" />

      <Badge variant={isBackOnline ? "positive" : "critical"} pulse>
        {isBackOnline ? "Back online" : "Offline Mode"}
      </Badge>

      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/10 text-accent">
        {isBackOnline ? (
          <Wifi className="h-7 w-7" aria-hidden="true" />
        ) : (
          <WifiOff className="h-7 w-7" aria-hidden="true" />
        )}
      </div>

      <h1 className="font-display text-xl font-semibold text-fg">
        {isBackOnline ? "Connection restored" : "You’re offline"}
      </h1>

      <p className="text-sm text-muted">
        {isBackOnline
          ? "Your connection is back — reload to pick up right where you left off."
          : "PFW couldn’t reach the network. Your budgets, balances, and transactions need a live connection to load — nothing here is ever shown from a stale cache."}
      </p>

      <button
        type="button"
        onClick={handleRetry}
        className="uv-btn-press mt-2 flex items-center gap-2 rounded-md border border-border bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
        {isBackOnline ? "Reload" : "Try again"}
      </button>
    </div>
  );
}
