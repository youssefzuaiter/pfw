import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/types";
import { LOGIN_RATE_LIMIT, loginRateLimitKey } from "../../../../../server/auth/credentials";
import { createAuthenticationChallenge, findAuthenticationCandidate } from "../../../../../server/auth/webauthn-admin-ops";
import { base64UrlToUint8Array, getRelyingParty } from "../../../../../server/auth/webauthn";
import { checkRateLimit } from "../../../../../server/api/rate-limit";
import { isTrustedOrigin } from "../../../../../server/api/verify-origin";
import { jsonBadRequest, jsonForbidden, jsonTooManyRequests } from "../../../../../server/api/responses";

/**
 * Device-Bound Biometrics via Passkeys (ad hoc) — issues a real WebAuthn
 * authentication challenge for a SIGN-IN attempt, which is by definition
 * unauthenticated. Deliberately does NOT go through `guardMutation()`
 * (same reason `POST /api/auth/register` doesn't, §3ff): identity
 * doesn't exist yet. Origin verification applied by hand instead; rate
 * limited by the submitted email, reusing the SAME bucket
 * `checkLoginRateLimit` already uses for password attempts (auth.ts's
 * `passkey` provider's own doc comment explains why sharing one budget
 * per email is more defensible than two independent ones).
 *
 * Response shape is deliberately IDENTICAL whether or not the email has
 * any registered passkeys — `options.allowCredentials` is simply empty
 * for a account with none, never a distinguishing error — so this
 * endpoint can't be used to enumerate which accounts have passkeys set
 * up (Section 2.2's enumeration-safety rule, applied here the same way
 * `verifyCredentials` already applies it to password login).
 */
const BodySchema = z.object({ email: z.string().trim().toLowerCase().email() });

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
    return jsonBadRequest("Invalid request body", parsed.error.issues);
  }
  const { email } = parsed.data;

  const rate = checkRateLimit(loginRateLimitKey(email), LOGIN_RATE_LIMIT);
  if (!rate.allowed) {
    return jsonTooManyRequests(rate.resetAt);
  }

  const candidate = await findAuthenticationCandidate(email);

  const rp = getRelyingParty();
  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    userVerification: "preferred",
    allowCredentials: candidate?.credentials.map((cred) => ({
      id: base64UrlToUint8Array(cred.credentialId),
      type: "public-key" as const,
      transports: cred.transports as AuthenticatorTransportFuture[],
    })),
  });

  // A real challenge row is only ever created for a REAL candidate — an
  // unknown email still gets real-shaped `options` back (so the browser's
  // own timing/behavior can't reveal account existence either), but there
  // is nothing to verify against later, so `challengeId` is null and the
  // subsequent `signIn("passkey", ...)` attempt will simply fail closed
  // in `authorize()` exactly like an unknown-email password attempt does.
  const challengeId = candidate ? await createAuthenticationChallenge(candidate.userId, options.challenge) : null;

  return NextResponse.json({ options, challengeId });
}
