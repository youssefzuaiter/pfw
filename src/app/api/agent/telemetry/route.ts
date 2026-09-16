import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../server/auth/current-user";
import { checkRateLimit } from "../../../../server/api/rate-limit";
import { jsonTooManyRequests } from "../../../../server/api/responses";
import { fetchPaperTraderTelemetry } from "../../../../server/paper-trader/telemetry-client";

/**
 * Same-origin proxy for the Tier-0 agent's live event feed, polled by
 * `AgentTelemetryTerminal` every 4s (ad hoc, trader integration
 * hardening — see `telemetry-client.ts` for why the browser no longer
 * fetches the agent's origin itself).
 *
 * A GET, read-only pass-through — no state changes, so like
 * `GET /api/agent/health` it deliberately skips `guardMutation`'s
 * Origin/CSRF check but keeps identity resolution (the feed is only for
 * signed-in users of this app, never anonymous) and rate limiting, set
 * comfortably above the terminal's real ~15/min so a second open tab
 * doesn't trip it while a runaway loop still would.
 */
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 60 };

export async function GET() {
  const user = await getCurrentUser();

  const rate = await checkRateLimit(`agent:telemetry:${user.id}`, RATE_LIMIT);
  if (!rate.allowed) {
    return jsonTooManyRequests(rate.resetAt);
  }

  const telemetry = await fetchPaperTraderTelemetry();
  return NextResponse.json(telemetry);
}
