import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requestPasswordReset } from "../../../../server/auth/password-reset";
import { checkRateLimit } from "../../../../server/api/rate-limit";
import { isTrustedOrigin } from "../../../../server/api/verify-origin";
import { jsonBadRequest, jsonForbidden, jsonTooManyRequests } from "../../../../server/api/responses";

/**
 * Password reset request (auth hardening pass, ad hoc post-§3ff) —
 * deliberately does NOT go through `guardMutation()`, same reason
 * registration doesn't: there's no identity to resolve yet. Origin
 * verification and rate limiting are applied by hand, same shape as
 * `POST /api/auth/register`.
 *
 * ASVS "generic messaging" requirement: the response is IDENTICAL
 * whether or not an account exists for the submitted email — see
 * `requestPasswordReset`'s own doc comment for how that uniformity holds
 * even under a Resend outage, not just on the happy path.
 */
const PER_EMAIL_RATE_LIMIT = { windowMs: 60_000, maxRequests: 5 };
const GLOBAL_RATE_LIMIT = { windowMs: 60_000, maxRequests: 30 };

const BodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
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
  const { email } = parsed.data;

  const globalRate = checkRateLimit("auth:forgot-password:global", GLOBAL_RATE_LIMIT);
  if (!globalRate.allowed) {
    return jsonTooManyRequests(globalRate.resetAt);
  }
  const emailRate = checkRateLimit(`auth:forgot-password:${email}`, PER_EMAIL_RATE_LIMIT);
  if (!emailRate.allowed) {
    return jsonTooManyRequests(emailRate.resetAt);
  }

  await requestPasswordReset(email);

  // Always the same message, always 200 — see this route's own doc
  // comment above.
  return NextResponse.json({ message: "If an account exists for that email, a reset link has been sent." });
}
