import type { NextConfig } from "next";
import withBundleAnalyzer from "@next/bundle-analyzer";

/**
 * Static, per-response security headers.
 *
 * The Content-Security-Policy header is intentionally NOT set here: it needs a
 * fresh per-request nonce, which only `src/proxy.ts` can generate. Everything
 * that is safe to be identical on every response lives here instead.
 */
const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  {
    // Defense-in-depth for browsers that ignore CSP frame-ancestors.
    key: "X-Frame-Options",
    value: "DENY",
  },
];

const nextConfig: NextConfig = {
  cacheComponents: true,
  poweredByHeader: false,
  // Docker production builds (Dockerfile, root): traces only the files
  // each route actually needs into `.next/standalone`, which is what
  // lets the runner stage skip installing `node_modules` at all. Native-
  // binary packages this app depends on at runtime (`argon2`, used by
  // Argon2id password hashing, §3ff; `@prisma/client`/`pg`, the database
  // driver) do NOT need a manual `serverExternalPackages` entry here —
  // verified against this exact installed Next version's own docs
  // (node_modules/next/dist/docs/.../serverExternalPackages.md): all
  // three are already in Next's built-in auto-external-packages list,
  // which is specifically what makes standalone tracing correctly copy
  // their native `.node` binaries (loaded via non-statically-analyzable
  // `require()` calls that a naive file tracer would otherwise miss)
  // instead of trying to bundle them.
  //
  // An explicit OPT-IN (`NEXT_OUTPUT_STANDALONE=1`, set only by the
  // Dockerfile's builder stage), not the reverse. It was previously
  // `process.env.VERCEL ? undefined : "standalone"` — off only on
  // Vercel, on everywhere else by default — which fixed the real,
  // verified Vercel build failure (`ENOENT .next/next-server.js.nft.json`;
  // Vercel's builder does its own function bundling from the normal trace
  // file and never looks for `.next/standalone` at all, so the two output
  // modes aren't layerable) but broke every OTHER caller of a plain `next
  // start` — standalone mode replaces the normal trace output with a
  // self-contained `.next/standalone/` server that `next start` doesn't
  // know how to run at all (`next start` prints "does not work with
  // output: standalone configuration" and serves a broken build) —
  // caught live via `npm run test:e2e` (`next build && next start`)
  // failing sign-in with no session ever established, not assumed from
  // the warning text alone. Standalone output is only ever actually
  // consumed by the Dockerfile's `runner` stage running `node server.js`
  // directly (see Dockerfile's own comments) — every other build (local
  // `npm run build`/`npm run start`, this CI's own build/verify/e2e
  // steps, a Vercel build) wants the normal trace output instead.
  output: process.env.NEXT_OUTPUT_STANDALONE === "1" ? "standalone" : undefined,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

// Off by default — only wraps the build with a bundle-size report when
// explicitly asked for (`ANALYZE=true npm run build`), per Phase 6's
// requirement to verify the R3F hero's JS footprint against the ~250KB
// gzipped budget without paying that analysis cost on every normal build.
const analyzeBundles = withBundleAnalyzer({ enabled: process.env.ANALYZE === "true" });

export default analyzeBundles(nextConfig);
