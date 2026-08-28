import "server-only";
import { NextResponse } from "next/server";

/**
 * Shared JSON response shapes for route handlers. `notFound()` is used
 * for BOTH "doesn't exist" and "exists but belongs to someone else" —
 * per Section 2.2, an IDOR attempt must never get a 403, which would
 * leak that the resource exists at all.
 */

export function jsonNotFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export function jsonBadRequest(message: string, details?: unknown) {
  return NextResponse.json({ error: message, details }, { status: 400 });
}

/** For a request-level policy violation (e.g. a CSRF Origin mismatch) — not an ownership check, so 403 is correct here (contrast jsonNotFound above). */
export function jsonForbidden(message = "Forbidden") {
  return NextResponse.json({ error: message }, { status: 403 });
}

export function jsonTooManyRequests(resetAt: number) {
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  return NextResponse.json(
    { error: "Too many requests" },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

export function jsonServerError() {
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}
