import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/types";
import { guardMutation } from "../../../../../server/api/guard-mutation";
import { jsonBadRequest, jsonServerError } from "../../../../../server/api/responses";
import { consumeRegistrationChallenge, createAuthenticator } from "../../../../../server/dal/authenticators";
import { ensureRecoveryCodes } from "../../../../../server/dal/recovery-codes";
import { getRelyingParty, toArrayBufferBackedUint8Array, uint8ArrayToBase64Url } from "../../../../../server/auth/webauthn";

/**
 * Device-Bound Biometrics via Passkeys (ad hoc) — Phase 3, step 2:
 * verifies the browser's completed registration ceremony
 * (`@simplewebauthn/browser`'s `startRegistration()` response) against
 * the challenge issued by `register-options`, then persists the new
 * `Authenticator` row. `consumeRegistrationChallenge` deletes the
 * challenge the instant it's read — this endpoint gets exactly one
 * verification attempt per issued challenge, same "consume once" shape
 * as this app's other single-use tokens.
 */
const BodySchema = z.object({
  challengeId: z.string().min(1),
  response: z.unknown(),
  deviceLabel: z.string().trim().min(1).max(100).default("Passkey"),
});

export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "webauthn:register-verify");
  if ("response" in guard) return guard.response;
  const { user } = guard;

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

  const expectedChallenge = await consumeRegistrationChallenge(user.id, parsed.data.challengeId);
  if (!expectedChallenge) {
    return jsonBadRequest("This registration attempt has expired — try again.");
  }

  // `verifyRegistrationResponse` THROWS for a structurally malformed
  // response (e.g. `clientDataJSON` that isn't valid base64url-encoded
  // JSON) rather than returning `{ verified: false }` — verified live
  // against the real library, not assumed: a deliberately-bogus request
  // during this feature's own verification pass came back a 500 before
  // this `try` was scoped down to just this call, which is the wrong
  // status for bad CLIENT input crossing a trust boundary, not a genuine
  // server fault. Scoped narrowly so a real unexpected error (e.g. a DB
  // failure in `createAuthenticator` below) still correctly falls through
  // to the outer catch as a 500.
  let verification;
  try {
    const rp = getRelyingParty();
    verification = await verifyRegistrationResponse({
      response: parsed.data.response as RegistrationResponseJSON,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
    });
  } catch {
    return jsonBadRequest("Could not verify this passkey — try again.");
  }

  if (!verification.verified || !verification.registrationInfo) {
    return jsonBadRequest("Could not verify this passkey — try again.");
  }

  try {
    const { registrationInfo } = verification;
    await createAuthenticator(user.id, {
      credentialId: uint8ArrayToBase64Url(registrationInfo.credentialID),
      publicKey: toArrayBufferBackedUint8Array(registrationInfo.credentialPublicKey),
      counter: BigInt(registrationInfo.counter),
      deviceType: registrationInfo.credentialDeviceType,
      backedUp: registrationInfo.credentialBackedUp,
      transports: (parsed.data.response as RegistrationResponseJSON).response.transports ?? [],
      deviceLabel: parsed.data.deviceLabel,
    });

    // Phase 3, Security & Recovery: "upon successful MFA setup, generate
    // a set of 8 ... backup codes." Only actually generates a fresh
    // batch when none are already unused (`ensureRecoveryCodes`'s own
    // doc comment) — a SECOND passkey registration finds the first
    // registration's still-unused codes and returns `null`, so this
    // response's `recoveryCodes` field is simply absent that time rather
    // than silently invalidating codes the user already saved.
    const recoveryCodes = await ensureRecoveryCodes(user.id);

    return NextResponse.json({ ok: true, ...(recoveryCodes ? { recoveryCodes } : {}) });
  } catch (error) {
    console.error("POST /api/auth/webauthn/register-verify failed", error);
    return jsonServerError();
  }
}
