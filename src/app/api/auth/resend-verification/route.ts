import { NextResponse, type NextRequest } from "next/server";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { sendEmailVerification } from "../../../../server/auth/email-verification";
import { jsonServerError } from "../../../../server/api/responses";

/**
 * Authenticated "resend verification email" action (auth hardening
 * pass, ad hoc post-§3ff) — the settings-page counterpart to the
 * automatic send at registration. Unlike `forgot-password`/`verify-email`,
 * this one HAS a real session, so it goes through the normal
 * `guardMutation()` preamble like every other authenticated mutation.
 */
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 3 };

export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "auth:resend-verification", RATE_LIMIT);
  if ("response" in guard) return guard.response;
  const { user } = guard;

  if (user.emailVerified) {
    return NextResponse.json({ ok: true, alreadyVerified: true });
  }

  try {
    await sendEmailVerification(user.id, user.email);
    return NextResponse.json({ ok: true, alreadyVerified: false });
  } catch (error) {
    console.error("POST /api/auth/resend-verification failed", error);
    return jsonServerError();
  }
}
