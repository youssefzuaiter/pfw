import "server-only";
import type { NextRequest } from "next/server";
import type { NextResponse } from "next/server";
import { getCurrentUser } from "../auth/current-user";
import { checkRateLimit, type RateLimitOptions } from "./rate-limit";
import { jsonForbidden, jsonTooManyRequests } from "./responses";
import { isTrustedOrigin } from "./verify-origin";

const DEFAULT_RATE_LIMIT: RateLimitOptions = { windowMs: 60_000, maxRequests: 30 };

export type GuardedRequest = { user: Awaited<ReturnType<typeof getCurrentUser>> };

/**
 * The common preamble every mutating route needs, in the order Section 5
 * lists these controls: Origin/Host verification, server-resolved
 * identity (never a client-supplied user id), then rate limiting. Each
 * route still does its own Zod validation and DAL call afterward — this
 * only factors out what's identical across all of them.
 */
export async function guardMutation(
  request: NextRequest,
  routeName: string,
  rateLimit: RateLimitOptions = DEFAULT_RATE_LIMIT,
): Promise<GuardedRequest | { response: NextResponse }> {
  if (!isTrustedOrigin(request)) {
    return { response: jsonForbidden("Origin mismatch") };
  }

  const user = await getCurrentUser();

  const result = checkRateLimit(`${routeName}:${user.id}`, rateLimit);
  if (!result.allowed) {
    return { response: jsonTooManyRequests(result.resetAt) };
  }

  return { user };
}
