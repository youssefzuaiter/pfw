import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { confirmPasswordReset } from "../../../../server/auth/password-reset";
import { checkRateLimit } from "../../../../server/api/rate-limit";
import { isTrustedOrigin } from "../../../../server/api/verify-origin";
import { jsonBadRequest, jsonForbidden, jsonTooManyRequests } from "../../../../server/api/responses";

/**
 * Password reset confirmation (auth hardening pass, ad hoc post-§3ff) —
 * unauthenticated like `forgot-password`'s own request route (the token
 * itself is the credential here, same shape as the household-invite
 * accept flow). Rate-limited by the submitted TOKEN, not an email — an
 * attacker guessing a specific token benefits from no email-based
 * bucketing, and a legitimate user only ever submits their own one token
 * a handful of times.
 */
const PER_TOKEN_RATE_LIMIT = { windowMs: 60_000, maxRequests: 10 };
const GLOBAL_RATE_LIMIT = { windowMs: 60_000, maxRequests: 60 };

const BodySchema = z.object({
  token: z.string().trim().min(1),
  newPassword: z.string().min(8).max(200),
  totpCode: z.string().trim().min(1).max(20).optional(),
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
  const { token, newPassword, totpCode } = parsed.data;

  const globalRate = checkRateLimit("auth:reset-password:global", GLOBAL_RATE_LIMIT);
  if (!globalRate.allowed) {
    return jsonTooManyRequests(globalRate.resetAt);
  }
  const tokenRate = checkRateLimit(`auth:reset-password:${token}`, PER_TOKEN_RATE_LIMIT);
  if (!tokenRate.allowed) {
    return jsonTooManyRequests(tokenRate.resetAt);
  }

  const result = await confirmPasswordReset(token, newPassword, totpCode);
  if (!result.ok) {
    if (result.error === "invalid_or_expired") {
      return NextResponse.json({ error: "This reset link is invalid or has expired." }, { status: 400 });
    }
    // "totp_required" / "totp_invalid" — distinct codes the client uses
    // to show a code field vs. "that code was wrong," same UX shape
    // `auth.ts`'s login TOTP challenge already gives (never an
    // enumeration risk here either: the token itself already proved
    // this specific reset request is legitimate, before TOTP is ever
    // checked).
    return NextResponse.json({ error: "totp_challenge", code: result.error }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
