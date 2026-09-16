"use client";

import { useEffect, useState } from "react";

/**
 * Header status for the Tier-0 paper-trading agent, polled from this
 * app's own `GET /api/agent/health` every 30s (that route probes the
 * agent server-side — the browser never touches the agent's origin).
 *
 * Four states, not two (ad hoc, trader integration hardening): besides
 * up/down, the route now reports whether the account receipts book
 * against actually resolves and how many signed receipts the agent has
 * queued but not delivered. Both are "the agent is up but something is
 * silently wrong" conditions that used to be invisible from the UI — the
 * first surfaced as a 500 on every webhook, the second as a trade
 * missing from the ledger — so they get the amber warning treatment
 * rather than being folded into a reassuring green dot.
 */
const POLL_INTERVAL_MS = 30_000;

type BackendStatus = "checking" | "online" | "degraded" | "offline";

type HealthPayload = {
  online: boolean;
  outboxPending: number | null;
  paperTradingUser: "ok" | "missing" | "unconfigured";
};

const DOT_CLASS: Record<BackendStatus, string> = {
  checking: "bg-slate-500",
  online: "bg-positive uv-badge-pulse",
  degraded: "bg-signature uv-badge-pulse",
  offline: "bg-negative",
};

const TEXT_CLASS: Record<BackendStatus, string> = {
  checking: "text-slate-400",
  online: "text-positive",
  degraded: "text-signature",
  offline: "text-negative",
};

function parseHealth(body: unknown): HealthPayload | null {
  if (typeof body !== "object" || body === null) return null;
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.online !== "boolean") return null;
  const paperTradingUser = candidate.paperTradingUser;
  const outboxPending = candidate.outboxPending;
  return {
    online: candidate.online,
    outboxPending: typeof outboxPending === "number" && Number.isInteger(outboxPending) ? outboxPending : null,
    paperTradingUser:
      paperTradingUser === "ok" || paperTradingUser === "missing" || paperTradingUser === "unconfigured"
        ? paperTradingUser
        : "unconfigured",
  };
}

function describe(health: HealthPayload): { status: BackendStatus; label: string } {
  if (!health.online) return { status: "offline", label: "AI Engine Offline" };
  const warnings: string[] = [];
  if (health.paperTradingUser !== "ok") warnings.push("trader account not linked");
  if (health.outboxPending !== null && health.outboxPending > 0) {
    warnings.push(`${health.outboxPending} undelivered receipt${health.outboxPending === 1 ? "" : "s"}`);
  }
  if (warnings.length === 0) return { status: "online", label: "AI Engine Online" };
  return { status: "degraded", label: `AI Engine Online · ${warnings.join(" · ")}` };
}

export function BackendStatusBadge() {
  const [view, setView] = useState<{ status: BackendStatus; label: string }>({
    status: "checking",
    label: "AI Engine — checking…",
  });

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const response = await fetch("/api/agent/health", { cache: "no-store" });
        if (cancelled) return;
        if (!response.ok) {
          setView({ status: "offline", label: "AI Engine Offline" });
          return;
        }
        const body: unknown = await response.json();
        if (cancelled) return;
        const health = parseHealth(body);
        setView(health ? describe(health) : { status: "offline", label: "AI Engine Offline" });
      } catch {
        if (!cancelled) setView({ status: "offline", label: "AI Engine Offline" });
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
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${DOT_CLASS[view.status]}`} />
      <span className={TEXT_CLASS[view.status]}>{view.label}</span>
    </div>
  );
}
