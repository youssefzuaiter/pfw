import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../../server/auth/current-user";
import { checkRateLimit } from "../../../../../server/api/rate-limit";
import { jsonTooManyRequests } from "../../../../../server/api/responses";
import { listAuthenticators } from "../../../../../server/dal/authenticators";

/**
 * Lists the caller's own registered passkeys for the Settings panel — a
 * GET, read-only endpoint over the caller's own data, so it deliberately
 * skips `guardMutation`'s Origin/CSRF check but keeps identity resolution
 * and rate limiting directly, same pattern as `GET /api/tax/simulate`.
 */
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 30 };

export async function GET() {
  const user = await getCurrentUser();

  const rate = checkRateLimit(`webauthn:list:${user.id}`, RATE_LIMIT);
  if (!rate.allowed) {
    return jsonTooManyRequests(rate.resetAt);
  }

  const authenticators = await listAuthenticators(user.id);
  return NextResponse.json({
    authenticators: authenticators.map((a) => ({
      id: a.id,
      deviceLabel: a.deviceLabel,
      deviceType: a.deviceType,
      backedUp: a.backedUp,
      transports: a.transports,
      createdAtIso: a.createdAt.toISOString(),
      lastUsedAtIso: a.lastUsedAt?.toISOString() ?? null,
    })),
  });
}
