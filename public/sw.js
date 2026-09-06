// PFW hand-rolled service worker (Phase 4, ad hoc).
//
// Deliberately NOT built via next-pwa or Serwist. Verified before
// choosing this: `next-pwa` hasn't published since August 2022 and only
// hooks into webpack's config — this app's `next dev`/`next build` both
// run on Turbopack, which never executes that hook, so the plugin would
// silently produce no service worker at all. Its maintained fork
// (`@ducanh2912/next-pwa`) still hard-requires webpack. `@serwist/next`
// hits the identical Turbopack gap (it warns about this itself at
// runtime); `@serwist/turbopack`, the package's own Turbopack-specific
// variant, states in its own source that it's "for when NOT using
// cacheComponents" — and this app's `cacheComponents: true` is
// load-bearing (it's what gets the CSP nonce onto every script tag, a
// real bug this app's history already found and fixed once). A plain
// static file has no build-time transform at all, so it works
// identically regardless of which bundler built the rest of the app.
//
// Scope, deliberately narrow: this only ever caches the OFFLINE
// FALLBACK PAGE, nothing else. It does not cache API responses or any
// financial data — this app's standing rule that no live financial
// figure is ever served stale applies exactly as much to a service
// worker cache as to Next's own request cache (AGENTS.md §3c: even
// `getCurrentUser()`/`buildDashboardData()` use React's per-REQUEST
// `cache()`, never a cross-request one, for this exact reason). Offline
// means a clear "you're offline" page, never a stale balance presented
// as current.

const CACHE_NAME = "pfw-offline-v1";
const OFFLINE_URL = "/~offline";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.add(OFFLINE_URL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  // Only ever intercept full-page navigations. Every other request —
  // API calls, static assets, RSC payloads — goes straight to the
  // network untouched, exactly as if this service worker didn't exist.
  if (event.request.mode !== "navigate") return;

  event.respondWith(
    fetch(event.request).catch(() => caches.open(CACHE_NAME).then((cache) => cache.match(OFFLINE_URL))),
  );
});
