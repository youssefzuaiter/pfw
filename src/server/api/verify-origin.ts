import "server-only";
import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

/**
 * Byte-for-byte comparison in constant time (Section 2.3's
 * `crypto.timingSafeEqual` requirement). Note on scope: Origin and Host
 * are not secrets — the client sends Origin itself and Host is public —
 * so unlike a session token or HMAC signature, there's no confidential
 * value here for a timing side-channel to actually extract. This is
 * applied anyway as a cheap defense-in-depth/ASVS-habit measure, not
 * because a real timing attack exists against this comparison; see
 * `docs/SECURITY-CHECKLIST.md` item 10, which stays "deferred" for the
 * control's actual target (auth token/secret comparisons — none exist
 * yet, since there's no real auth) rather than being marked satisfied by
 * this.
 *
 * `timingSafeEqual` throws on unequal-length buffers instead of
 * returning `false`, so length is checked first — that branch is a
 * length comparison, not a value comparison, and length isn't sensitive
 * for either of these public strings.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Verifies a state-changing request's Origin header matches the
 * request's own Host — defense-in-depth against CSRF (Section 5),
 * alongside the CORS preflight that already blocks a cross-origin
 * `fetch()` using a JSON content-type from completing at all (this app
 * never sends `Access-Control-Allow-Origin`, so a preflighted cross-
 * origin request fails before the browser sends the real one).
 *
 * A *missing* Origin header is allowed through, not rejected: browsers
 * omit it on some legitimate same-origin requests (e.g. certain
 * navigations), so hard-failing on absence would reject real traffic —
 * OWASP's CSRF cheat sheet guidance is to verify Origin when present,
 * not to require its presence.
 */
export function isTrustedOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;

  const host = request.headers.get("host");
  if (!host) return false;

  try {
    return constantTimeEquals(new URL(origin).host, host);
  } catch {
    return false;
  }
}
