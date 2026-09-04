import "server-only";
import { getAppUrl } from "../env";

/**
 * Shared WebAuthn (Device-Bound Biometrics via Passkeys, ad hoc)
 * configuration and encoding helpers — used by both the registration/
 * authentication option-generation routes and the `passkey` Credentials
 * provider (`auth.ts`). Deliberately NOT Auth.js's own built-in WebAuthn
 * provider (`next-auth/providers/webauthn`) — verified directly against
 * the installed `@auth/core` source that it requires a database Adapter
 * (`getUserInfo` throws `MissingAdapter` otherwise) implementing
 * `getAuthenticator`/`createAuthenticator`/`listAuthenticatorsByUserId`/
 * `updateAuthenticatorCounter`/`getAccount`/`linkAccount`/`getUser`/
 * `getUserByEmail`/`createUser` — a first-time architectural change this
 * app's existing JWT-session, no-adapter design (§3ff) was built
 * specifically to avoid, plus a new `Account`-shaped table this app has
 * never needed (pure Credentials auth, no OAuth-style provider linking).
 * Confirmed with the user before building: `@simplewebauthn/server` used
 * directly against this app's own `Authenticator`/`Challenge` tables,
 * with a second lightweight Credentials provider minting the session —
 * exactly how TOTP already extends `authorize()` — keeps the existing
 * architecture completely intact.
 *
 * `Buffer`'s built-in `"base64url"` encoding is used for every
 * Uint8Array<->string conversion the library needs — no extra dependency
 * for a one-line, standard conversion, matching this app's habit of
 * owning small mechanical primitives directly (§3cc's `toPgVectorLiteral`,
 * the CSV tokenizer, etc.).
 */

/**
 * Returns a `Uint8Array<ArrayBuffer>` specifically, not the looser
 * `Uint8Array<ArrayBufferLike>` a plain `new Uint8Array(buffer)` around a
 * `Buffer` would infer — TypeScript's typed-array generics (5.7+) treat
 * those as distinct (same class of mismatch `forecaster-worker-handlers.ts`'s
 * own `F32` alias documents, in the opposite direction: there it widened
 * to accept `ArrayBufferLike`; here Prisma's generated `Bytes` input type
 * requires the narrower, concretely-`ArrayBuffer`-backed form). Copying
 * into a freshly `new Uint8Array(length)`-allocated array — always
 * genuinely `ArrayBuffer`-backed — sidesteps the mismatch instead of
 * fighting it with a cast. Used both for a base64url string decode
 * (below) AND to normalize `@simplewebauthn/server`'s own returned
 * `credentialPublicKey`/`credentialID` byte arrays before handing them to
 * Prisma, since those hit the identical mismatch.
 */
export function toArrayBufferBackedUint8Array(source: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(source.length);
  out.set(source);
  return out;
}

export function base64UrlToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  return toArrayBufferBackedUint8Array(Buffer.from(value, "base64url"));
}

export function uint8ArrayToBase64Url(value: Uint8Array | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/** 5 minutes — matches Auth.js's own `DEFAULT_WEBAUTHN_TIMEOUT`, a reasonable ceremony window before a challenge must be considered abandoned. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type RelyingPartyConfig = { id: string; name: string; origin: string };

/**
 * Derived from `getAppUrl()` (this app's own operator-set public-origin
 * signal, added for auth hardening's email-link building, §3jj) — the
 * SAME source `auth.ts`'s own cookie-hardening logic already reads,
 * rather than trusting a per-request `Host` header, which `verify-origin.ts`'s
 * own Origin-check already treats as adversarial input for state-changing
 * requests (Section 2.4). The WebAuthn RP ID must be a valid domain name
 * with no scheme/port (`url.hostname`, not `url.host`) per the spec.
 */
export function getRelyingParty(): RelyingPartyConfig {
  const url = new URL(getAppUrl());
  return { id: url.hostname, name: "PFW", origin: url.origin };
}
