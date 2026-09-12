import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../server/auth/current-user";
import { checkRateLimit } from "../../../../server/api/rate-limit";
import { jsonTooManyRequests } from "../../../../server/api/responses";
import { checkPaperTraderBackendHealth } from "../../../../server/paper-trader/health-client";

/**
 * A GET, read-only status check — no state changes, so this deliberately
 * skips `guardMutation`'s Origin/CSRF check (Section 2.4's CSRF concern
 * is specific to state-changing requests), same as
 * `GET /api/analytics/monte-carlo`/`GET /api/tax/simulate`, but keeps
 * identity resolution and rate limiting by calling those primitives
 * directly. Polled client-side every 30s by `BackendStatusBadge`
 * (dashboard header) — rate limited generously above that real usage
 * rate purely as defense-in-depth against a client hammering it in a
 * loop, the same reasoning the Monte Carlo route's own tighter-than-
 * default limit gives.
 */
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 20 };

export async function GET() {
  const user = await getCurrentUser();

  const rate = checkRateLimit(`agent:health:${user.id}`, RATE_LIMIT);
  if (!rate.allowed) {
    return jsonTooManyRequests(rate.resetAt);
  }

  const online = await checkPaperTraderBackendHealth();
  return NextResponse.json({ online });
}
