import path from "node:path";
import { request, type FullConfig } from "@playwright/test";

/**
 * Real authentication (AGENTS.md §3ff) landed after this e2e suite was
 * originally written (Phase 7) — every route/API call this suite drives
 * is now gated behind a real session, so it needs to actually sign in
 * once, up front, and share that session across every spec file, rather
 * than each test hitting a redirect-to-`/login` or a bare 401. This is
 * what was silently broken (a pre-existing gap, not caused by any single
 * feature pass) until this fix (§3kk).
 *
 * Claims the seeded `demo@pfw.local` row for the duration of the run —
 * the ONE account guaranteed to hold full seeded demo data after a fresh
 * `npm run db:seed` (security.spec.ts's own `beforeAll` already assumed
 * this precondition and throws a clear error if it's missing) — rather
 * than any real developer's own personal account, which the suite's
 * mutating tests (category PATCH, a temporary XSS payload) have no
 * business touching. `global-teardown.ts` restores it to unclaimed
 * afterward, the exact same snapshot/restore shape
 * `tests/integration/auth-credentials.test.ts` already uses for this
 * same row.
 *
 * Uses Playwright's own `request.newContext()` for the whole login
 * dance (register → fetch CSRF token → POST credentials) rather than
 * hand-parsing `Set-Cookie` headers and reconstructing cookie attributes
 * — a real API request context does real cookie-jar handling (Secure,
 * SameSite, `__Host-` prefix rules included), which matters here
 * specifically because THIS app's own cookie config shape now differs
 * between a `https://` deployment and a plain-HTTP one (`auth.ts`'s
 * `getAppUrl().startsWith("https://")` gate) — hand-reconstructing the
 * cookie would mean re-encoding that same conditional logic a second
 * time, exactly the kind of drift this avoids entirely.
 */

const STORAGE_STATE_PATH = path.resolve(__dirname, ".auth/session.json");
export const E2E_EMAIL = "demo@pfw.local";
export const E2E_PASSWORD = "e2e-suite-password-not-a-real-secret-123";
export const E2E_DISPLAY_NAME = "E2E Test Runner";

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use?.baseURL as string;
  if (!baseURL) throw new Error("global-setup: no baseURL configured");

  const context = await request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });

  // Register (or, on a re-run against an already-claimed row, proceed —
  // see this file's own doc comment on why the precondition is "a fresh
  // npm run db:seed just ran", not defensively engineered around).
  const registerResponse = await context.post("/api/auth/register", {
    data: { email: E2E_EMAIL, password: E2E_PASSWORD, displayName: E2E_DISPLAY_NAME },
  });
  if (registerResponse.status() !== 201 && registerResponse.status() !== 409) {
    throw new Error(
      `global-setup: failed to register the e2e test account (${registerResponse.status()}): ${await registerResponse.text()}`,
    );
  }

  const csrfResponse = await context.get("/api/auth/csrf");
  const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };

  const loginResponse = await context.post("/api/auth/callback/credentials", {
    form: { csrfToken, email: E2E_EMAIL, password: E2E_PASSWORD, json: "true" },
  });
  if (!loginResponse.ok()) {
    throw new Error(`global-setup: sign-in failed (${loginResponse.status()}): ${await loginResponse.text()}`);
  }

  const sessionResponse = await context.get("/api/auth/session");
  const session = (await sessionResponse.json()) as { user?: { email?: string } } | null;
  if (session?.user?.email !== E2E_EMAIL) {
    throw new Error(`global-setup: sign-in did not establish a session (got: ${JSON.stringify(session)})`);
  }

  await context.storageState({ path: STORAGE_STATE_PATH });
  await context.dispose();
}

export { STORAGE_STATE_PATH };
