import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { auth } from "./server/auth/auth";

/**
 * Routes reachable WITHOUT this app's own authenticated session
 * (AGENTS.md §3ff). Everything else is protected by default — the
 * opposite of an allowlist-what-needs-auth model, since every existing
 * page/route already calls `getCurrentUser()` and assumes a resolved
 * user, so the safe default is "requires auth unless explicitly listed
 * here," not the reverse.
 *
 * `/vault/recover/[token]` and its API twin are NOT an oversight — the
 * Dead Man's Switch's entire premise (§3t) is that a beneficiary
 * recovering an emergency vault is, by design, a different real-world
 * person than this app's own authenticated user. Gating those behind a
 * login this app has no way to hand a beneficiary would break an
 * already-shipped, already-verified feature.
 *
 * `/api/health` and `/api/health/ready` (Punch List Phase 4, the k8s
 * deployment prep pass): a kubelet liveness/readiness probe carries no
 * session and must never be redirected to `/login` — a probe that
 * receives a 307 instead of a 200 reads as "unhealthy" to Kubernetes,
 * which would then repeatedly restart an app pod that was actually fine.
 */
const PUBLIC_EXACT_PATHS = new Set(["/login", "/register", "/welcome", "/api/health", "/api/health/ready"]);
const PUBLIC_PATH_PREFIXES = ["/api/auth/", "/vault/recover/", "/api/dead-mans-switch/recover/"];

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT_PATHS.has(pathname)) return true;
  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

const AUTH_ENTRY_PATHS = new Set(["/login", "/register"]);

/**
 * Next.js 16 proxy (formerly `middleware`) — always runs on the Node.js
 * runtime, which is required here because the nonce is generated with
 * Node's `crypto` module rather than the Web Crypto API. Wrapped with
 * Auth.js's `auth(...)` helper (rather than calling the plain `auth()`
 * form used in Server Components) specifically because THIS execution
 * context doesn't have the same request-scoped `headers()`/`cookies()`
 * async context Server Components get — the wrapper is what makes the
 * verified session available as `request.auth` here at all.
 */
export const proxy = auth((request) => {
  const pathname = request.nextUrl.pathname;
  const isAuthenticated = Boolean(request.auth?.user?.id);

  // Real authentication gate — NOT `getCurrentUser()`'s own defense-in-
  // depth throw (src/server/auth/current-user.ts's doc comment explains
  // why a redirect thrown that deep isn't reliable in this app: §3c
  // already found and fixed a real case of a redirect() call failing to
  // become a genuine top-level HTTP response under this exact
  // Next.js/cacheComponents combination — the same reasoning that made
  // the "/" -> "/dashboard" redirect below a proxy-level concern in the
  // first place, now extended to the login gate itself).
  if (!isPublicPath(pathname) && !isAuthenticated) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Visiting /login or /register while already signed in has nothing
  // useful to show — send them where they were actually headed.
  if (isAuthenticated && AUTH_ENTRY_PATHS.has(pathname)) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

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
  //
  // 'wasm-unsafe-eval' + worker-src (AGENTS.md §3q, the client-side
  // receipt OCR engine): a narrowly-scoped WASM-compilation allowance,
  // NOT the broad 'unsafe-eval' — it permits WebAssembly.instantiate but
  // still blocks eval()/new Function() string-based execution. Tesseract.js's
  // worker script and WASM core are self-hosted under public/tesseract/
  // specifically so worker-src/script-src can both stay 'self' rather than
  // needing a third-party origin for *executable code*. connect-src's
  // cdn.jsdelivr.net exception is deliberately narrower than that: it's
  // reached only to fetch the English language *training data* file (a
  // static data blob, never executed) — no receipt image or extracted
  // text is ever sent there, only a GET for that one public asset.
  //
  // huggingface.co / *.huggingface.co / *.hf.co (+ its two known Xet CDN
  // subdomain shapes) (AGENTS.md §3u, §3y — the Self-Learning Vector
  // Categorization Engine's client-side embedding model): the same
  // "self-host the executable runtime, allow a narrow connect-src
  // exception only for the DATA it needs" split as Tesseract.js above —
  // onnxruntime-web's WASM binary is self-hosted under
  // public/onnx-runtime/, so script-src/worker-src stay 'self' only; only
  // the model's weight files (an .onnx binary + tokenizer JSON, never
  // executed as script) are fetched remotely, from the Hugging Face Hub.
  // `*.huggingface.co` alone was verified INSUFFICIENT by hand (§3y): a
  // real browser trace of an actual model download showed the large
  // `.onnx` weights file's redirect resolving to
  // `us.aws.cdn.hf.co` — Hugging Face's newer "Xet" storage backend
  // (https://huggingface.co/blog/migrating-the-hub-to-xet), a
  // *different* domain (hf.co, not huggingface.co) that a bare
  // `*.huggingface.co` wildcard never covered. Worth recording precisely
  // why three more entries are needed rather than one: CSP wildcards
  // match exactly one subdomain label, so `*.hf.co` alone does NOT cover
  // a two-label host like `us.aws.cdn.hf.co` — `*.aws.cdn.hf.co` and
  // `*.gcp.cdn.hf.co` (Hugging Face's two documented multi-region CDN
  // shapes) are what's actually needed, alongside `*.xethub.hf.co` for
  // the Xet content-addressed-storage bridge itself. Every one of these
  // still resolves to Hugging Face-operated infrastructure serving the
  // same non-executed model-weight data `*.huggingface.co` already
  // covers — this is a same-provider CDN-domain gap being closed, not a
  // new third party being trusted.
  //
  // AGENTS.md §3x hardening pass — explicitly confirmed, not just
  // inherited by omission: script-src and style-src have NEVER carried
  // 'unsafe-inline' or 'unsafe-eval' in this file, and still don't.
  // Every legitimately-needed exception to that is narrow and named
  // above by directive, not a blanket relaxation:
  // 'wasm-unsafe-eval' (WASM compilation only, not eval()/new Function()),
  // 'strict-dynamic' (lets Next's own nonce'd bootstrap scripts load
  // their split chunks without individually nonce-ing each one), and
  // worker-src's 'blob:' (this app's Web Workers — src/lib/workers/*.worker.ts
  // — are constructed via `new Worker(new URL(...))`, which Turbopack may
  // serve through a blob: URL depending on build mode; 'self' alone
  // isn't reliably sufficient across both, and neither token grants
  // *script-executing* origins beyond this app's own bundle). connect-src
  // keeps BOTH of its pre-existing exceptions — cdn.jsdelivr.net
  // (Tesseract's OCR language data, §3q) alongside every Hugging
  // Face-operated host (embedding weights, §3u/§3y, see the block above
  // for why that's now 5 entries, not 2) — deliberately, not just
  // Hugging Face alone: dropping cdn.jsdelivr.net would silently break
  // the already-shipped receipt-OCR feature for a directive this task's
  // actual target (script-src/style-src's inline/eval posture) never
  // touches; every exception here is independently justified, narrow (no
  // wildcard broader than one documented CDN subdomain shape per entry),
  // and audited together rather than one being addressed in isolation.
  const csp = `
    default-src 'self';
    script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval';
    worker-src 'self' blob:;
    style-src 'self' 'nonce-${nonce}';
    img-src 'self' blob: data:;
    font-src 'self';
    connect-src 'self' https://cdn.jsdelivr.net https://huggingface.co https://*.huggingface.co https://*.hf.co https://*.aws.cdn.hf.co https://*.gcp.cdn.hf.co https://*.xethub.hf.co;
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
});

export const config = {
  // Skip static assets and the favicon; every page and API route still gets
  // a CSP nonce.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
