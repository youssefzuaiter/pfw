import { NextResponse, type NextRequest } from "next/server";
import QRCode from "qrcode";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { jsonServerError } from "../../../../server/api/responses";
import { beginTotpSetup } from "../../../../server/dal/mfa";

/**
 * Begins (or restarts — see `beginTotpSetup`'s own doc comment) TOTP MFA
 * setup: generates a fresh secret, stores it as PENDING (not yet
 * `totpEnabled`), and returns the `otpauth://` URI as a QR code the
 * client renders directly (`<img src={qrCodeDataUrl} />`) — no client-side
 * QR-rendering dependency needed, matching this app's habit of doing the
 * one-time heavy lifting server-side rather than growing the client
 * bundle for a single settings-page action. The raw secret is also
 * returned as a fallback for a user whose authenticator app supports
 * manual entry but not camera scanning.
 */
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 10 };

export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "mfa:setup", RATE_LIMIT);
  if ("response" in guard) return guard.response;
  const { user } = guard;

  try {
    const { secret, otpauthUri } = await beginTotpSetup(user.id, user.email);
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUri);
    return NextResponse.json({ secret, otpauthUri, qrCodeDataUrl });
  } catch (error) {
    console.error("POST /api/mfa/setup failed", error);
    return jsonServerError();
  }
}
