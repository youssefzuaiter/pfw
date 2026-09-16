import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import argon2 from "argon2";
import { Client } from "pg";
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
 * Takes over the seeded `demo@pfw.local` row for the duration of the run
 * — the ONE account guaranteed to hold full seeded demo data after a
 * fresh `npm run db:seed` (security.spec.ts's own `beforeAll` already
 * assumed this precondition and throws a clear error if it's missing) —
 * rather than any real developer's own personal account, which the
 * suite's mutating tests (category PATCH, a temporary XSS payload) have
 * no business touching.
 *
 * "Takes over" means: snapshot the row's `passwordHash`/`displayName`,
 * set the hash to the suite's own password directly in the database, and
 * let `global-teardown.ts` restore the snapshot. It used to REGISTER the
 * row instead, which only works while the row is unclaimed — and since
 * §3uu the seed pre-claims it whenever `NEXT_PUBLIC_DEMO_MODE=true`, so
 * registration answered 409 and the sign-in that followed used the wrong
 * password. Setting the hash works in both modes, and restoring the
 * snapshot (rather than hard-resetting to unclaimed, as the old teardown
 * did) leaves Demo Login working afterwards in demo mode.
 *
 * Uses Playwright's own `request.newContext()` for the login dance
 * (fetch CSRF token → POST credentials) rather than hand-parsing
 * `Set-Cookie` headers and reconstructing cookie attributes — a real API
 * request context does real cookie-jar handling (Secure, SameSite,
 * `__Host-` prefix rules included), which matters here specifically
 * because THIS app's own cookie config shape now differs between a
 * `https://` deployment and a plain-HTTP one (`auth.ts`'s
 * `getAppUrl().startsWith("https://")` gate) — hand-reconstructing the
 * cookie would mean re-encoding that same conditional logic a second
 * time, exactly the kind of drift this avoids entirely.
 */

const AUTH_DIR = path.resolve(__dirname, ".auth");
const STORAGE_STATE_PATH = path.join(AUTH_DIR, "session.json");
/** Where `global-teardown.ts` finds what to put back. Lives next to the session state, gitignored with it. */
export const DEMO_ROW_SNAPSHOT_PATH = path.join(AUTH_DIR, "demo-row-snapshot.json");
export const E2E_EMAIL = "demo@pfw.local";
export const E2E_PASSWORD = "e2e-suite-password-not-a-real-secret-123";

export type DemoRowSnapshot = { id: string; passwordHash: string | null; displayName: string };

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use?.baseURL as string;
  if (!baseURL) throw new Error("global-setup: no baseURL configured");
  if (!process.env.DATABASE_URL) throw new Error("global-setup: DATABASE_URL must be set (the suite needs the local Postgres)");

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const { rows } = await db.query<DemoRowSnapshot>(
      'SELECT id, "passwordHash", "displayName" FROM "User" WHERE email = $1',
      [E2E_EMAIL],
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`global-setup: no ${E2E_EMAIL} row — run \`npm run db:seed\` first (the suite's precondition is a freshly seeded database)`);
    }
    mkdirSync(AUTH_DIR, { recursive: true });
    writeFileSync(DEMO_ROW_SNAPSHOT_PATH, JSON.stringify(row));

    const passwordHash = await argon2.hash(E2E_PASSWORD, { type: argon2.argon2id });
    await db.query('UPDATE "User" SET "passwordHash" = $1 WHERE id = $2', [passwordHash, row.id]);
  } finally {
    await db.end();
  }

  const context = await request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });

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
