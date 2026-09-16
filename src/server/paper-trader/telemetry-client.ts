import "server-only";
import { parseTelemetryEvents, type TelemetryEvent } from "../../lib/agent-telemetry";
import { getPaperTraderServiceUrl } from "../env";

/**
 * Server-side fetch of the Tier-0 agent's in-memory `/telemetry` feed,
 * for `GET /api/agent/telemetry` (ad hoc, trader integration hardening).
 *
 * Until this existed the `AgentTelemetryTerminal` client component
 * polled the agent's origin straight from the browser, which needed a
 * plain-`http://127.0.0.1:8000` CSP `connect-src` exception and — the
 * real problem — could never work on the hosted deployment at all,
 * since that CSP list was hardcoded to loopback and the agent's Render
 * origin was never in it. Routing the poll through this app's own
 * server makes ARCHITECTURE.md's "the browser never talks to
 * paper-trader directly" claim true, drops the CSP exception, and lets
 * one `PAPER_TRADER_SERVICE_URL` serve every environment.
 *
 * Tight timeout: the terminal polls every 4s, so a hung agent must
 * surface as "unreachable" well inside one poll interval rather than
 * queueing overlapping requests. The body is validated through the same
 * `parseTelemetryEvents` the client uses, so a malformed event never
 * leaves this process.
 */
const TELEMETRY_TIMEOUT_MS = 3000;

export type PaperTraderTelemetry =
  | { online: true; events: TelemetryEvent[] }
  | { online: false; events: [] };

export async function fetchPaperTraderTelemetry(): Promise<PaperTraderTelemetry> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
  try {
    const response = await fetch(`${getPaperTraderServiceUrl()}/telemetry`, {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) return { online: false, events: [] };
    const body: unknown = await response.json();
    return { online: true, events: parseTelemetryEvents(body) };
  } catch {
    return { online: false, events: [] };
  } finally {
    clearTimeout(timeout);
  }
}
