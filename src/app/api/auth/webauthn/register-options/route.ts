import { NextResponse, type NextRequest } from "next/server";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/types";
import { guardMutation } from "../../../../../server/api/guard-mutation";
import { jsonServerError } from "../../../../../server/api/responses";
import { createRegistrationChallenge, listCredentialIds } from "../../../../../server/dal/authenticators";
import { base64UrlToUint8Array, getRelyingParty } from "../../../../../server/auth/webauthn";

/**
 * Device-Bound Biometrics via Passkeys (ad hoc) — Phase 3, step 1 of
 * registering a new passkey: an authenticated Settings action
 * (`guardMutation`-fronted like every other mutating route), generating
 * a real WebAuthn registration challenge and persisting it
 * (`createRegistrationChallenge`, a normal `withUserScope` write — the
 * caller already has a real session, unlike the authentication-side
 * ceremony). `excludeCredentials` is populated from the user's already-
 * registered passkeys so a platform authenticator that already holds one
 * of them won't offer to create a duplicate.
 *
 * `attestationType: "none"` — this app has no FIDO Metadata Service
 * integration and no enterprise attestation requirement, so requesting
 * attestation would only extract authenticator make/model information
 * this feature has no use for; skipping it is also the more privacy-
 * respecting default. `authenticatorSelection` prefers (not requires) a
 * discoverable/resident credential and user verification (biometric/PIN)
 * — "prefer," not "require," so this doesn't hard-fail on an
 * authenticator that can't satisfy one of them.
 */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "webauthn:register-options");
  if ("response" in guard) return guard.response;
  const { user } = guard;

  try {
    const rp = getRelyingParty();
    const existingCredentials = await listCredentialIds(user.id);

    const options = await generateRegistrationOptions({
      rpName: rp.name,
      rpID: rp.id,
      userID: user.id,
      userName: user.email,
      userDisplayName: user.displayName,
      attestationType: "none",
      excludeCredentials: existingCredentials.map((cred) => ({
        id: base64UrlToUint8Array(cred.credentialId),
        type: "public-key" as const,
        transports: cred.transports as AuthenticatorTransportFuture[],
      })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });

    const challengeId = await createRegistrationChallenge(user.id, options.challenge);

    return NextResponse.json({ options, challengeId });
  } catch (error) {
    console.error("POST /api/auth/webauthn/register-options failed", error);
    return jsonServerError();
  }
}
