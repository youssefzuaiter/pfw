import "server-only";
import { getPaperTraderHealthCheckUrl } from "../env";

/**
 * A dependency-free `fetch` wrapper (matches this app's habit of owning
 * small HTTP surfaces directly — the Frankfurter/CoinGecko/Ollama
 * clients) probing the Tier-0 paper-trading agent's `/health` endpoint
 * for `GET /api/agent/health`.
 *
 * A hosted free-tier deployment (Render) can take several seconds to
 * wake from a cold start, so this uses a more generous timeout than
 * `checkOllamaAvailability`'s 2s (a genuinely local process with no such
 * cold-start behavior) — long enough to not misreport a merely-slow-to-
 * wake service as offline, short enough that one slow check never stalls
 * the dashboard's 30s poll cycle into the next one.
 *
 * Besides liveness, the agent's `/health` body reports how many signed
 * receipts are sitting in its durable outbox waiting to be redelivered
 * (`outbox_pending`) — surfaced on the dashboard so a delivery backlog
 * is visible, not something discovered from a missing trade weeks
 * later. The body is untrusted data crossing a trust boundary like any
 * other; anything not shaped as expected reads as "unknown", never as a
 * number.
 */
const HEALTH_CHECK_TIMEOUT_MS = 8000;

export type PaperTraderHealth = {
  online: boolean;
  /** Undelivered receipts queued in the agent's outbox; `null` when the agent is offline or didn't report it. */
  outboxPending: number | null;
};

export async function checkPaperTraderBackendHealth(): Promise<PaperTraderHealth> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(getPaperTraderHealthCheckUrl(), {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) return { online: false, outboxPending: null };
    const body: unknown = await response.json().catch(() => null);
    return { online: true, outboxPending: readOutboxPending(body) };
  } catch {
    return { online: false, outboxPending: null };
  } finally {
    clearTimeout(timeout);
  }
}

function readOutboxPending(body: unknown): number | null {
  if (typeof body !== "object" || body === null || !("outbox_pending" in body)) return null;
  const value = (body as { outbox_pending: unknown }).outbox_pending;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
