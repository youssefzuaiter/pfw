import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC-SHA256 verification for the Tier-0 paper-trading agent's trade
 * receipts (the local FastAPI service that submits the Alpaca paper
 * orders). Pure — no DB, no `NextRequest`, no env access — so it's
 * directly testable with plain strings, the same `src/lib/` convention
 * every other engine in this app follows (AGENTS.md §3b) and the same
 * split `ledger-hash.ts` already uses for its own hashing primitive:
 * one definition of the scheme, shared by whoever needs it, so a
 * verifier can never silently drift from the signer.
 *
 * The signed material is `${timestamp}.${rawBody}` (Stripe's scheme).
 * Binding the timestamp INTO the MAC is what makes a captured receipt
 * un-replayable — rejecting a stale timestamp only means something if an
 * attacker can't move it forward, and they can't without invalidating
 * the digest.
 *
 * The caller MUST pass the raw request text, exactly as received.
 * `JSON.parse` followed by `JSON.stringify` re-serializes with different
 * key order and spacing, producing different bytes and therefore a
 * different digest — which is why the route reads `await request.text()`
 * and only parses AFTER this returns ok.
 */

export const SIGNATURE_HEADER = "x-signature-256";
export const TIMESTAMP_HEADER = "x-signature-timestamp";
export const IDEMPOTENCY_HEADER = "x-idempotency-key";

const SIGNATURE_PREFIX = "sha256=";

/**
 * How far the receipt's timestamp may be from this server's clock, in
 * seconds. Applied in BOTH directions: a future-dated timestamp is as
 * suspect as an old one, and tolerating it would hand an attacker an
 * arbitrarily long window to replay a captured receipt later.
 */
export const REPLAY_WINDOW_SECONDS = 300;

export type SignatureFailureReason =
  | "missing_signature"
  | "missing_timestamp"
  | "malformed_timestamp"
  | "stale_timestamp"
  | "signature_mismatch";

export type SignatureVerificationResult = { ok: true } | { ok: false; reason: SignatureFailureReason };

/**
 * Byte-for-byte comparison in constant time (Section 2.3's
 * `timingSafeEqual` requirement). Unlike `verify-origin.ts`'s own copy of
 * this — which compares Origin/Host, both public values, and says so —
 * this one guards a real secret-derived digest, so the constant-time
 * property is load-bearing here rather than defense-in-depth habit.
 *
 * `timingSafeEqual` throws on unequal-length buffers instead of returning
 * false, so length is checked first. That leaks only the length of an
 * attacker-supplied header, never anything about the expected digest,
 * which is always 64 hex characters.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/** The hex HMAC-SHA256 over `${timestamp}.${rawBody}`. The single definition of this app's webhook signing scheme. */
export function computeWebhookSignature(rawBody: string, timestamp: string, secret: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
}

export type VerifyWebhookSignatureParams = {
  /** The request body exactly as received — never a re-serialized object. */
  rawBody: string;
  signatureHeader: string | null;
  timestampHeader: string | null;
  secret: string;
  /** Injected rather than read from `Date.now()` so the replay window is testable without faking timers. */
  nowMs: number;
};

export function verifyWebhookSignature({
  rawBody,
  signatureHeader,
  timestampHeader,
  secret,
  nowMs,
}: VerifyWebhookSignatureParams): SignatureVerificationResult {
  if (!signatureHeader) return { ok: false, reason: "missing_signature" };
  if (!timestampHeader) return { ok: false, reason: "missing_timestamp" };

  // Reject anything that isn't a plain run of digits BEFORE Number():
  // Number("") is 0, Number(" 12 ") is 12, and Number("0x10") is 16, so a
  // bare isNaN check would let several non-timestamps through.
  if (!/^\d{1,15}$/.test(timestampHeader)) return { ok: false, reason: "malformed_timestamp" };

  const skewSeconds = Math.abs(nowMs / 1000 - Number(timestampHeader));
  if (skewSeconds > REPLAY_WINDOW_SECONDS) return { ok: false, reason: "stale_timestamp" };

  const provided = signatureHeader.startsWith(SIGNATURE_PREFIX)
    ? signatureHeader.slice(SIGNATURE_PREFIX.length)
    : signatureHeader;

  const expected = computeWebhookSignature(rawBody, timestampHeader, secret);
  if (!constantTimeEquals(expected, provided)) return { ok: false, reason: "signature_mismatch" };

  return { ok: true };
}
