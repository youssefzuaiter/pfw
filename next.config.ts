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
  // Deliberately OFF when building on Vercel (`process.env.VERCEL`,
  // Vercel's own always-set build-env flag): standalone mode replaces
  // Next's normal `.next/next-server.js.nft.json` trace output with the
  // self-contained `.next/standalone/` directory instead — verified live
  // against a real Vercel build, which failed at its own
  // "onBuildComplete" step with `ENOENT .next/next-server.js.nft.json`
  // once `next build` finished successfully, because Vercel's builder
  // (`@vercel/next`) does its own function bundling from that trace file
  // and never looks for `.next/standalone` at all — the two output modes
  // are for two different deployment targets, not layerable.
  output: process.env.VERCEL ? undefined : "standalone",
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
