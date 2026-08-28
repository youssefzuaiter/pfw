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
