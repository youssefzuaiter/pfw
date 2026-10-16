import { NextResponse } from "next/server";
import { buildSafeToSpendData, serializeSafeToSpend } from "../../../../server/analytics/build-safe-to-spend-data";
import { checkRateLimit } from "../../../../server/api/rate-limit";
import { jsonServerError, jsonTooManyRequests } from "../../../../server/api/responses";
import { getCurrentUser } from "../../../../server/auth/current-user";

/**
 * Safe to Spend (formula: `src/lib/safe-to-spend.ts`) as JSON. A GET, so
 * like the other read-only compute endpoints it skips `guardMutation`'s
 * Origin/CSRF check (nothing changes state) but keeps the other two halves:
 * the identity comes from the session, never from the request, and the call
 * is rate limited. It takes no parameters: the figure is always the signed-in
 * user's, for the current UTC month, as of now. The dashboard card reads the
 * same `buildSafeToSpendData`, so the two cannot disagree.
 */
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 30 };

export async function GET() {
  const user = await getCurrentUser();

  const rate = await checkRateLimit(`analytics:safe-to-spend:${user.id}`, RATE_LIMIT);
  if (!rate.allowed) {
    return jsonTooManyRequests(rate.resetAt);
  }

  try {
    const data = await buildSafeToSpendData(user.id);
    return NextResponse.json(serializeSafeToSpend(data), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("GET /api/analytics/safe-to-spend failed", error);
    return jsonServerError();
  }
}
