import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { confirmEmailVerification } from "../../../../server/auth/email-verification";
import { checkRateLimit } from "../../../../server/api/rate-limit";
import { isTrustedOrigin } from "../../../../server/api/verify-origin";
import { jsonBadRequest, jsonForbidden, jsonTooManyRequests } from "../../../../server/api/responses";

/**
 * Email verification confirmation (auth hardening pass, ad hoc
 * post-§3ff) — unauthenticated, same reasoning as `reset-password`'s own
 * route: the token is opened from an email link, possibly with no
 * session in that browser at all.
 */
const PER_TOKEN_RATE_LIMIT = { windowMs: 60_000, maxRequests: 10 };
const GLOBAL_RATE_LIMIT = { windowMs: 60_000, maxRequests: 60 };

const BodySchema = z.object({
  token: z.string().trim().min(1),
});

export async function POST(request: NextRequest) {
  if (!isTrustedOrigin(request)) {
    return jsonForbidden("Origin mismatch");
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonBadRequest("Invalid JSON body");
  }

  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return jsonBadRequest("Invalid request", parsed.error.issues);
  }
  const { token } = parsed.data;

  const globalRate = checkRateLimit("auth:verify-email:global", GLOBAL_RATE_LIMIT);
  if (!globalRate.allowed) {
    return jsonTooManyRequests(globalRate.resetAt);
  }
  const tokenRate = checkRateLimit(`auth:verify-email:${token}`, PER_TOKEN_RATE_LIMIT);
  if (!tokenRate.allowed) {
    return jsonTooManyRequests(tokenRate.resetAt);
  }

  const result = await confirmEmailVerification(token);
  if (!result.ok) {
    return NextResponse.json({ error: "This verification link is invalid or has expired." }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
