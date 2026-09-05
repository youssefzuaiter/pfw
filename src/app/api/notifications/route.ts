import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../server/auth/current-user";
import { checkRateLimit } from "../../../server/api/rate-limit";
import { jsonServerError, jsonTooManyRequests } from "../../../server/api/responses";
import { listUnreadNotifications } from "../../../server/dal/notifications";

/**
 * The dashboard header bell's fetch endpoint — the caller's own unread
 * `Notification` rows, most recent first. Deliberately skips
 * `guardMutation`'s Origin/CSRF check, same reasoning as
 * `GET /api/user-settings`/`GET /api/tax/simulate` (Section 2.4's CSRF
 * concern is specific to state-changing requests) — but keeps identity
 * resolution and rate limiting by calling those primitives directly.
 */
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 30 };

export async function GET() {
  const user = await getCurrentUser();
  const rate = checkRateLimit(`notifications:get:${user.id}`, RATE_LIMIT);
  if (!rate.allowed) return jsonTooManyRequests(rate.resetAt);

  try {
    const notifications = await listUnreadNotifications(user.id);
    return NextResponse.json({ notifications });
  } catch (error) {
    console.error("GET /api/notifications failed", error);
    return jsonServerError();
  }
}
