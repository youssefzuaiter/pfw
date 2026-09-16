import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../server/auth/current-user";
import { checkRateLimit } from "../../../../server/api/rate-limit";
import { jsonTooManyRequests } from "../../../../server/api/responses";
import { checkPaperTraderBackendHealth } from "../../../../server/paper-trader/health-client";
import { resolvePaperTradingUser } from "../../../../server/paper-trader/resolve-paper-trading-user";

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
 *
 * Reports three things the badge renders as one status (ad hoc, trader
 * integration hardening): whether the agent answers at all, whether the
 * account its receipts book against actually resolves (this was a silent
 * 500-on-every-webhook failure before — `resolve-paper-trading-user.ts`),
 * and how many receipts the agent has queued but not yet delivered. The
 * two agent-side facts come from the SAME `PAPER_TRADER_SERVICE_URL` the
 * halt route and the telemetry proxy use, so the header can no longer
 * report one process while the agent page shows another.
 */
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 20 };

export async function GET() {
  const user = await getCurrentUser();

  const rate = await checkRateLimit(`agent:health:${user.id}`, RATE_LIMIT);
  if (!rate.allowed) {
    return jsonTooManyRequests(rate.resetAt);
  }

  const [health, paperTradingUser] = await Promise.all([
    checkPaperTraderBackendHealth(),
    resolvePaperTradingUser().catch((error: unknown) => {
      console.error("GET /api/agent/health: could not resolve the paper-trading user", error);
      return { status: "unconfigured" as const };
    }),
  ]);

  return NextResponse.json({
    online: health.online,
    outboxPending: health.outboxPending,
    paperTradingUser: paperTradingUser.status,
  });
}
