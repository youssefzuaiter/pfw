"use client";

import { useEffect, useState } from "react";

/**
 * Polls the Tier-0 paper-trading agent's hosted (Render) deployment via
 * this app's own `GET /api/agent/health` — a same-origin server route,
 * not a direct client-side fetch to the Render URL, so this needs no
 * CSP `connect-src` exception and doesn't depend on that external
 * service's own CORS configuration (unlike `AgentTelemetryTerminal`'s
 * direct-to-local-agent polling, which only works because that target is
 * a same-machine dev process, not a real cross-origin host).
 */
const POLL_INTERVAL_MS = 30_000;

type BackendStatus = "checking" | "online" | "offline";

const STATUS_LABEL: Record<BackendStatus, string> = {
  checking: "AI Engine — checking…",
  online: "AI Engine Online",
  offline: "AI Engine Offline",
};

const DOT_CLASS: Record<BackendStatus, string> = {
  checking: "bg-slate-500",
  online: "bg-positive uv-badge-pulse",
  offline: "bg-negative",
};

export function BackendStatusBadge() {
  const [status, setStatus] = useState<BackendStatus>("checking");

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const response = await fetch("/api/agent/health", { cache: "no-store" });
        if (cancelled) return;
        if (!response.ok) {
          setStatus("offline");
          return;
        }
        const data: unknown = await response.json();
        // Re-checked AFTER this second await, not just after the fetch:
        // the effect can be torn down while the body is still being read,
        // and the guard above has already been passed by then.
        if (cancelled) return;
        const online = typeof data === "object" && data !== null && "online" in data && (data as { online: unknown }).online === true;
        setStatus(online ? "online" : "offline");
      } catch {
        if (!cancelled) setStatus("offline");
      }
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="flex items-center gap-2 text-xs font-medium text-slate-400" role="status">
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${DOT_CLASS[status]}`} />
      <span className={status === "online" ? "text-positive" : status === "offline" ? "text-negative" : "text-slate-400"}>
        {STATUS_LABEL[status]}
      </span>
    </div>
  );
}
