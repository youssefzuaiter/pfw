/**
 * The Tier-0 paper-trading agent's telemetry event shape — mirrors
 * `scheduler.py`'s `TelemetryAction` in the sibling `~/paper-trader`
 * service. Pure and dependency-free so BOTH sides of this app can share
 * one definition: the server-side proxy route (`GET /api/agent/telemetry`)
 * validates what the agent returned before forwarding it, and the
 * `AgentTelemetryTerminal` client component validates again what it
 * received. Extracted from that component (ad hoc, trader integration
 * hardening) when the browser stopped talking to the agent directly.
 */

export type TelemetryAction =
  | "wake"
  | "evaluate"
  | "reject"
  | "execute"
  | "settle"
  | "sleep"
  | "error"
  | "critical_alert";

export type TelemetryEvent = {
  timestamp: string;
  action: TelemetryAction;
  ticker: string | null;
  status: string;
  details: string;
};

export const TELEMETRY_ACTIONS: ReadonlySet<string> = new Set<TelemetryAction>([
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
 * Filters an untrusted JSON body down to well-formed events, dropping
 * anything else silently — the agent is a separate process whose output
 * is data crossing a trust boundary, never something to spread straight
 * into React state (AGENTS.md §3tt found exactly that mistake here once).
 */
export function parseTelemetryEvents(body: unknown): TelemetryEvent[] {
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
