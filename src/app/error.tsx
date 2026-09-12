"use client";

import { useEffect } from "react";

/**
 * Route-level error boundary. This app had none at all, which is what
 * turned two individually-narrow render/serialization faults into
 * whole-screen outages: a `RangeError` thrown while formatting a goal's
 * projected completion date (src/lib/goal-progress.ts's
 * `projectCompletionDate` doc comment has the full story) blanked
 * /dashboard and /goals outright, and an unvalidated telemetry payload
 * did the same to /trading/agent. Both root causes are fixed; this
 * exists so the NEXT one degrades to a recoverable screen instead of a
 * blank page.
 *
 * Deliberately does NOT render `error.message`. A Server Component's
 * thrown error is redacted to a generic message + digest in production
 * by Next itself, but a Client Component's is not — and this app's
 * client tree touches decrypted goal notes and vault plaintext, so
 * echoing an arbitrary message into the DOM is exactly the kind of
 * incidental disclosure §2's "never leak internals to the client" rule
 * exists to prevent. The digest is shown instead: it's the stable,
 * non-sensitive handle that correlates to the full server-side log entry.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server-thrown errors are already logged server-side; this covers
    // the client-render half, which otherwise leaves no trace at all.
    console.error("Route error boundary caught:", error);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-2xl flex-col items-start gap-4 px-4 py-16 md:px-6">
      <h1 className="font-display text-xl font-semibold text-fg">Something went wrong on this screen</h1>
      <p className="text-sm text-muted">
        Your data is safe and nothing was changed. This screen failed to render — you can retry it, or head back to
        the dashboard.
      </p>
      {error.digest && (
        <p className="font-tabular-figures text-xs text-muted">
          Reference: <code className="rounded bg-surface px-1.5 py-0.5">{error.digest}</code>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="uv-btn-press rounded-md border border-transparent bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Try again
        </button>
        <a
          href="/dashboard"
          className="rounded-md border border-border px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Back to dashboard
        </a>
      </div>
    </div>
  );
}
