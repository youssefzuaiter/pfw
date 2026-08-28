import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Next.js 16 proxy (formerly `middleware`) — always runs on the Node.js
 * runtime, which is required here because the nonce is generated with
 * Node's `crypto` module rather than the Web Crypto API.
 */
export function proxy(request: NextRequest) {
  // A real, verified framework quirk: with cacheComponents on, a page
  // whose only content is a synchronous redirect() call gets its
  // redirect embedded inside the streamed RSC payload
  // (`"digest":"NEXT_REDIRECT;replace;/dashboard;307;"`) instead of
  // becoming a genuine top-level HTTP 307 — confirmed by hand with curl:
  // a plain GET to "/" came back "200 OK" with an HTML/RSC hybrid body, a
  // real browser only completes the navigation once its JS runtime reads
  // that embedded digest and does a client-side replace. That's a broken
  // redirect for any non-JS HTTP client (crawlers, curl, JS disabled) and
  // an avoidable blank-page flash even for a real browser. A middleware-
  // level redirect happens before any React rendering, so it's immune to
  // this — src/app/page.tsx keeps its own redirect() too, as a fallback
  // if this matcher were ever narrowed to exclude "/".
  if (request.nextUrl.pathname === "/") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  const nonce = randomBytes(16).toString("base64");

  // Next only stamps this nonce onto the scripts it renders (including its
  // own inline hydration payload, `self.__next_f.push(...)`) for
  // dynamically-rendered routes: it extracts the nonce by pattern-matching
  // `'nonce-...'` out of the *incoming request's* CSP header
  // (see next/dist/server/app-render/get-script-nonce-from-header.js).
  // A statically prerendered route has no such request at render time, so
  // the root layout deliberately reads headers() to force the app shell
  // dynamic — see the comment in src/app/layout.tsx.
  const csp = `
    default-src 'self';
    script-src 'self' 'nonce-${nonce}' 'strict-dynamic';
    style-src 'self' 'nonce-${nonce}';
    img-src 'self' blob: data:;
    font-src 'self';
    connect-src 'self';
    object-src 'none';
    base-uri 'self';
    form-action 'self';
    frame-ancestors 'none';
    upgrade-insecure-requests;
  `
    .replace(/\s{2,}/g, " ")
    .trim();

  // Forward the nonce to Server Components via a request header so any
  // future inline <script nonce={nonce}> can read it with headers().
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  // Also set it on the outgoing response — this is what the browser (and
  // Next's own inline bootstrap scripts, which detect the nonce from this
  // header) actually enforce against.
  response.headers.set("Content-Security-Policy", csp);

  return response;
}

export const config = {
  // Skip static assets and the favicon; every page and API route still gets
  // a CSP nonce.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
