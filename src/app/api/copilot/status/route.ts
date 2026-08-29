import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../server/auth/current-user";
import { checkRateLimit } from "../../../../server/api/rate-limit";
import { jsonTooManyRequests } from "../../../../server/api/responses";
import { checkOllamaAvailability } from "../../../../server/copilot/ollama-client";

/**
 * A cheap, read-only health check the copilot sidebar calls when it
 * opens, so "Ollama isn't running" can be shown up front (input
 * disabled, a clear message) instead of only after a failed send. Rate
 * limited lightly, same reasoning as `GET /api/analytics/monte-carlo` —
 * no state change, no DB query, so this skips `guardMutation`'s Origin
 * check but keeps identity resolution and a rate limit.
 */
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 30 };

export async function GET() {
  const user = await getCurrentUser();

  const rate = checkRateLimit(`copilot:status:${user.id}`, RATE_LIMIT);
  if (!rate.allowed) {
    return jsonTooManyRequests(rate.resetAt);
  }

  const availability = await checkOllamaAvailability();
  return NextResponse.json(availability);
}
