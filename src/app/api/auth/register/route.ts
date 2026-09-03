import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { registerUser } from "../../../../server/auth/credentials";
import { sendEmailVerification } from "../../../../server/auth/email-verification";
import { checkRateLimit } from "../../../../server/api/rate-limit";
import { isTrustedOrigin } from "../../../../server/api/verify-origin";
import { jsonBadRequest, jsonForbidden, jsonTooManyRequests } from "../../../../server/api/responses";

/**
 * Registration (AGENTS.md §3ff) — deliberately does NOT go through
 * `guardMutation()`, the same reason `POST /api/dead-mans-switch/recover/[token]`
 * (§3t) doesn't: `guardMutation` resolves identity via `getCurrentUser()`,
 * which is exactly what doesn't exist yet for someone registering. Origin
 * verification is still applied by hand — CSRF defense-in-depth doesn't
 * depend on already having an identity to protect.
 *
 * Rate limited by the SUBMITTED EMAIL, not a user id (none exists yet) —
 * bounds automated registration-flooding against one target address; a
 * coarser fixed-key limit bounds flooding across many different emails
 * from the same abusive client.
 */
const PER_EMAIL_RATE_LIMIT = { windowMs: 60_000, maxRequests: 5 };
const GLOBAL_RATE_LIMIT = { windowMs: 60_000, maxRequests: 30 };

const BodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(200),
  displayName: z.string().trim().min(1).max(200),
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
    return jsonBadRequest("Invalid registration request", parsed.error.issues);
  }
  const { email, password, displayName } = parsed.data;

  const globalRate = checkRateLimit("auth:register:global", GLOBAL_RATE_LIMIT);
  if (!globalRate.allowed) {
    return jsonTooManyRequests(globalRate.resetAt);
  }
  const emailRate = checkRateLimit(`auth:register:${email}`, PER_EMAIL_RATE_LIMIT);
  if (!emailRate.allowed) {
    return jsonTooManyRequests(emailRate.resetAt);
  }

  const result = await registerUser(email, password, displayName);
  if (!result.ok) {
    // Same status/shape either way — "email_taken" is the only failure
    // mode registerUser() returns, so there's nothing else to
    // distinguish; a 409 is the correct status for a real conflict,
    // unlike login's deliberately-identical-shaped failures (which
    // exist specifically to avoid revealing whether an email exists).
    return NextResponse.json({ error: "An account with this email already exists." }, { status: 409 });
  }

  // Fire-and-forget-but-awaited: sendEmailVerification never throws (it
  // catches and logs its own send failure internally, see that
  // function's doc comment), so this never turns a successful
  // registration into a failed response just because outbound email had
  // a bad moment.
  await sendEmailVerification(result.userId, email);

  return NextResponse.json({ ok: true, inherited: result.inherited }, { status: 201 });
}
