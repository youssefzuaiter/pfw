import "server-only";
import { OTP } from "otplib";

/**
 * RFC 6238 TOTP (Punch List Tier 2, item 3) via `otplib` v13 — a genuinely
 * different API shape from the older `authenticator` singleton some prior
 * `otplib` majors exported (checked directly against this exact installed
 * version's `.d.ts` files before writing this, not assumed from training
 * data — the same "verify a beta/unfamiliar library's real API before
 * using it" discipline this app's history applies to next-auth and
 * onnxruntime-web). `new OTP({ strategy: "totp" })` defaults to SHA-1,
 * 6 digits, a 30-second period — the same defaults every mainstream
 * authenticator app (Google Authenticator, Authy, 1Password, ...)
 * assumes, which is what actually matters for real interoperability, RFC
 * 6238 itself only requiring HMAC-SHA-1/256/512 with no single mandated
 * digit count or period.
 */
const ISSUER = "PFW";

// ±1 time step (30s) each direction — a standard, small allowance for
// client/server clock drift. RFC 6238 doesn't mandate a specific window;
// going wider trades real security margin away for forgivingness that
// isn't needed against any well-behaved authenticator app.
const EPOCH_TOLERANCE: [number, number] = [1, 1];

const otp = new OTP({ strategy: "totp" });

export function generateTotpSecret(): string {
  return otp.generateSecret();
}

/** `otpauth://totp/...` URI, rendered as a QR code by the setup route/UI. */
export function buildOtpauthUri(secret: string, accountEmail: string): string {
  return otp.generateURI({ issuer: ISSUER, label: accountEmail, secret });
}

export type TotpVerification = { valid: true; timeStep: number } | { valid: false };

/**
 * `afterTimeStep`, when provided, rejects a token whose matched time step
 * is <= that value — real replay protection using exactly what otplib's
 * own `VerifyResult` exposes for it. Not mandated by RFC 6238, but cheap
 * given the library already surfaces `timeStep`: without it, the same
 * 30-second code could be replayed (a shoulder-surfed or intercepted
 * value) for the remainder of its own validity window. Callers persist
 * the returned `timeStep` (`User.totpLastUsedTimeStep`) and pass it back
 * in as `afterTimeStep` on the next check.
 */
export async function verifyTotpCode(
  secret: string,
  code: string,
  afterTimeStep: number | null,
): Promise<TotpVerification> {
  try {
    const result = await otp.verify({
      secret,
      token: code,
      epochTolerance: EPOCH_TOLERANCE,
      ...(afterTimeStep != null ? { afterTimeStep } : {}),
    });
    if (!result.valid) return { valid: false };
    // The generic `OTP` wrapper's own VerifyResult type statically covers
    // both its TOTP and HOTP strategies, so TS can't prove `timeStep`
    // exists here even though this module only ever constructs the
    // wrapper with `strategy: "totp"` — `@otplib/totp`'s own
    // VerifyResultValid always sets it on a real TOTP match, which this
    // narrowing cast reflects.
    return { valid: true, timeStep: (result as { timeStep: number }).timeStep };
  } catch {
    // A malformed code (wrong length, non-numeric) throws inside otplib
    // rather than returning `{ valid: false }` — treated identically to
    // any other invalid code, never surfaced as a 500.
    return { valid: false };
  }
}
