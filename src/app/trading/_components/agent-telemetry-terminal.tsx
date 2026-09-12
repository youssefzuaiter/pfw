"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, type BadgeVariant } from "../../../components/badge/badge";
import { Spinner } from "../../../components/spinner/spinner";

/** Mirrors scheduler.py's TelemetryAction in the Tier-0 paper-trading agent. */
type TelemetryAction =
  | "wake"
  | "evaluate"
  | "reject"
  | "execute"
  | "settle"
  | "sleep"
  | "error"
  | "critical_alert";

type TelemetryEvent = {
  timestamp: string;
  action: TelemetryAction;
  ticker: string | null;
  status: string;
  details: string;
};

/**
 * The Tier-0 agent's own FastAPI service, running as a SEPARATE LOCAL
 * PROCESS on the same machine — not part of this Next.js app or its
 * database. See src/proxy.ts's connect-src comment for why this exact
 * origin is CSP-allowlisted; this only ever works when that process is
 * also running locally (`uvicorn main:app --port 8000` in ~/paper-trader).
 */
const AGENT_TELEMETRY_URL =
  process.env.NEXT_PUBLIC_AGENT_TELEMETRY_URL ?? "http://127.0.0.1:8000/telemetry";

const POLL_INTERVAL_MS = 4000;

const ACTION_LABEL: Record<TelemetryAction, string> = {
  wake: "Wake",
  evaluate: "Evaluate",
  reject: "Reject",
  execute: "Execute",
  settle: "Settle",
  sleep: "Sleep",
  error: "Error",
  critical_alert: "Circuit Breaker",
};

/** Gray for sleeping/idle steps, red for a Tier-0 rejection or the
 * portfolio circuit breaker tripping, green for a cleared gate
 * ("execute" — order accepted by the broker) or a confirmed real fill
 * ("settle" — the actual webhook-fired, ledger-booked event, per the
 * two-phase pending/settled split), amber for a genuine failure — a real
 * error is a different, more concerning thing than an expected Tier-0
 * reject, so it gets its own color rather than sharing "red". A
 * "critical_alert" (the hard daily-P&L circuit breaker) also gets the
 * Badge's `pulse` treatment below, on top of the same red as "reject" —
 * a standing portfolio-level halt warrants standing out more than an
 * ordinary per-order rejection. */
const ACTION_VARIANT: Record<TelemetryAction, BadgeVariant> = {
  wake: "neutral",
  evaluate: "neutral",
  sleep: "neutral",
  reject: "critical",
  critical_alert: "critical",
  execute: "positive",
  settle: "positive",
  error: "warning",
};

type ConnectionState = "connecting" | "connected" | "unreachable";

const TELEMETRY_ACTIONS = new Set<string>([
  "wake",
  "evaluate",
  "reject",
  "execute",
  "settle",
  "sleep",
  "error",
  "critical_alert",
]);

/**
 * The agent is a SEPARATE process this app doesn't control or deploy in
 * lockstep, so its response is untrusted input crossing a trust boundary
 * — exactly the treatment `rate-sync.ts`/`price-sync.ts` already give
 * Frankfurter and CoinGecko. A bare `as TelemetryEvent[]` cast was a real
 * crash, not a style nit: any non-array body (a FastAPI `{"detail": ...}`
 * error served with a 200 by a proxy, a `null`, or a future
 * `{events: [...]}` reshape) reached `[...events].reverse()` below and
 * threw `TypeError: events is not iterable` during render, which with no
 * `error.tsx` boundary in this app blanks the whole /trading/agent page.
 *
 * An unrecognized `action` is dropped rather than rendered: it would
 * otherwise index `ACTION_LABEL`/`ACTION_VARIANT` to `undefined`, which
 * renders an unlabelled row with `class="... undefined"` — a silent
 * mis-render that's harder to notice than a missing row.
 */
function parseTelemetryEvents(body: unknown): TelemetryEvent[] {
  if (!Array.isArray(body)) return [];
  return body.filter((item): item is TelemetryEvent => {
    if (typeof item !== "object" || item === null) return false;
    const candidate = item as Record<string, unknown>;
    return (
      typeof candidate.timestamp === "string" &&
      typeof candidate.action === "string" &&
      TELEMETRY_ACTIONS.has(candidate.action) &&
      typeof candidate.status === "string" &&
      typeof candidate.details === "string" &&
      (candidate.ticker === null || typeof candidate.ticker === "string")
    );
  });
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

/**
 * Polls the Tier-0 agent's /telemetry endpoint every few seconds and
 * renders its last (up to) 50 events as a live, color-coded activity
 * feed — newest first. All setState calls happen inside the interval's
 * callback, never synchronously in the effect body itself (the same
 * deferred-async shape MonteCarloWidget's debounced fetch already uses),
 * which is what keeps this clear of the react-hooks/set-state-in-effect
 * lint rule this app's history has hit more than once.
 */
export function AgentTelemetryTerminal() {
  const [events, setEvents] = useState<TelemetryEvent[]>([]);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [isHalting, setIsHalting] = useState(false);
  const [haltResult, setHaltResult] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * Calls PFW's OWN `/api/agent/halt` route — same-origin, authenticated
   * by the existing session cookie, same as every other mutating action
   * in this app. This component never signs anything or holds
   * `WEBHOOK_SECRET` itself; that route does the HMAC signing
   * server-side before forwarding to the Tier-0 agent. See that route's
   * own doc comment for why a client-side-signed request was rejected.
   */
  async function handleEmergencyHalt() {
    const confirmed = window.confirm(
      "This immediately halts the autonomous trading loop and cancels every open order at Alpaca. " +
        "There is no \"resume\" button — the agent process must be restarted to clear it. Continue?",
    );
    if (!confirmed) return;

    setIsHalting(true);
    setHaltResult(null);
    try {
      const response = await fetch("/api/agent/halt", { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; orders_canceled?: number; error?: string };
      if (!response.ok || !body.ok) {
        setHaltResult(body.error ?? `Halt request failed (HTTP ${response.status})`);
      } else {
        setHaltResult(`Halted. ${body.orders_canceled ?? 0} open order(s) canceled.`);
      }
    } catch (err) {
      console.error(err);
      setHaltResult("Could not reach the halt endpoint.");
    } finally {
      setIsHalting(false);
    }
  }

  useEffect(() => {
    async function poll() {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch(AGENT_TELEMETRY_URL, { signal: controller.signal });
        if (!response.ok) throw new Error(`Agent returned ${response.status}`);
        const body: unknown = await response.json();
        setEvents(parseTelemetryEvents(body));
        setConnection("connected");
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error(err);
        setConnection("unreachable");
      }
    }

    void poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      clearInterval(interval);
      abortRef.current?.abort();
    };
  }, []);

  const newestFirst = [...events].reverse();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted">Live activity</h2>
        <div className="flex items-center gap-2">
          <Badge variant={connection === "connected" ? "positive" : connection === "connecting" ? "neutral" : "critical"}>
            {connection === "connected" ? "Connected" : connection === "connecting" ? "Connecting…" : "Agent unreachable"}
          </Badge>
          <button
            type="button"
            onClick={handleEmergencyHalt}
            disabled={isHalting}
            className="uv-btn-press flex items-center gap-1.5 rounded-md border border-border bg-negative px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {isHalting && <Spinner />} Emergency Halt
          </button>
        </div>
      </div>

      {haltResult && <p className="text-xs text-muted">{haltResult}</p>}

      {connection === "unreachable" && (
        <p className="rounded-md border border-border bg-bg p-3 text-sm text-muted">
          Could not reach the Tier-0 agent at{" "}
          <code className="font-mono text-xs">{AGENT_TELEMETRY_URL}</code>. Make sure the FastAPI service is running
          (<code className="font-mono text-xs">uvicorn main:app --port 8000</code> in <code className="font-mono text-xs">paper-trader</code>).
        </p>
      )}

      {connection !== "unreachable" && newestFirst.length === 0 && (
        <p className="rounded-md border border-border bg-bg p-3 text-sm text-muted">
          No agent activity yet — either AUTONOMOUS_MODE is off, or the first cycle hasn&apos;t run yet.
        </p>
      )}

      {newestFirst.length > 0 && (
        <div className="max-h-[32rem] overflow-y-auto rounded-lg border border-border bg-surface font-mono text-xs">
          {newestFirst.map((event, index) => (
            <div
              key={`${event.timestamp}-${index}`}
              className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 last:border-b-0"
            >
              <span className="text-muted">{formatTimestamp(event.timestamp)}</span>
              <Badge variant={ACTION_VARIANT[event.action]} pulse={event.action === "critical_alert"}>
                {ACTION_LABEL[event.action]}
              </Badge>
              {event.ticker && <span className="font-semibold text-fg">{event.ticker}</span>}
              <span className="text-fg">{event.details}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
