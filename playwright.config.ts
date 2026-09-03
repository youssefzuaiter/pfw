import { defineConfig, devices } from "@playwright/test";
import { STORAGE_STATE_PATH } from "./tests/e2e/global-setup";

const PORT = 3100;
const BASE_URL = `http://localhost:${PORT}`;

/**
 * Phase 7's e2e layer — accessibility (axe-core) and security checks that
 * genuinely need a real browser and a real running server: computed-style
 * contrast, real keyboard tab order/focus traps, and real HTTP responses
 * (headers, CSRF, rate limiting). None of that is reachable from the
 * jsdom-based `component` Vitest project. Runs against a production build
 * (`next build && next start`), not `next dev`, so what's audited is what
 * would actually ship — a different port (3100) than the dev server's
 * 3000, so both can run at once without colliding.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  // One worker, on purpose: several specs mutate shared server-side state
  // against the single seeded demo user (an in-memory rate-limit bucket,
  // a transaction's merchantName/categoryId toggled and restored) — two
  // spec files racing against the same `next start` process could
  // otherwise interleave and produce order-dependent flakiness. This is
  // an audit suite, not a perf-sensitive one; correctness beats speed.
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 30_000,
  // Real authentication (AGENTS.md §3ff) landed after this suite was
  // originally written — every route/API call it drives is now gated
  // behind a real session, so `globalSetup` signs in once (claiming the
  // seeded demo account) and every test's `page`/`request` fixture reuses
  // that session via `storageState`, rather than each test hitting
  // `/login` or a bare 401 (§3kk).
  globalSetup: "./tests/e2e/global-setup",
  globalTeardown: "./tests/e2e/global-teardown",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    storageState: STORAGE_STATE_PATH,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `npm run build && npm run start -- -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
