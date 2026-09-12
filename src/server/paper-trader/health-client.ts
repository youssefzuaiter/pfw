import "server-only";
import { getPaperTraderHealthCheckUrl } from "../env";

/**
 * A dependency-free `fetch` wrapper (matches this app's habit of owning
 * small HTTP surfaces directly — the Frankfurter/CoinGecko/Ollama
 * clients) checking whether the Tier-0 paper-trading agent's hosted
 * deployment is reachable, for `GET /api/agent/health`.
 *
 * A Render free-tier service can take several seconds to wake from a
 * cold start, so this uses a more generous timeout than
 * `checkOllamaAvailability`'s 2s (a genuinely local process with no such
 * cold-start behavior) — long enough to not misreport a merely-slow-to-
 * wake service as offline, short enough that one slow check never stalls
 * the dashboard's 30s poll cycle into the next one.
 */
const HEALTH_CHECK_TIMEOUT_MS = 8000;

export async function checkPaperTraderBackendHealth(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(getPaperTraderHealthCheckUrl(), {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
