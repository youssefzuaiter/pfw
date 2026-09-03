import { Client } from "pg";
import { E2E_EMAIL } from "./global-setup";

/**
 * Restores the seeded `demo@pfw.local` row to its original unclaimed
 * state (`prisma/seed/israeli-data.ts`'s `SEED_USER`) after
 * `global-setup.ts` claims it for the run — same reasoning
 * `tests/integration/auth-credentials.test.ts`'s own `afterEach` already
 * gives for this exact row: leave the shared local dev DB no worse than
 * found, so a developer running `npm run test:e2e` doesn't wake up to a
 * "claimed" demo account they never registered themselves.
 *
 * Matched by id, not by the CURRENT email — global-setup claims the row
 * via its ORIGINAL `demo@pfw.local` email (Auth.js's `registerUser`
 * only ever targets that literal address), so it's still findable by
 * that same email here, unlike the household-member rows this same
 * pattern is careful never to touch.
 */
export default async function globalTeardown() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query(
      'UPDATE "User" SET email = $1, "passwordHash" = NULL, "displayName" = $2 WHERE email = $3',
      [E2E_EMAIL, "PFW Demo [דמו PFW]", E2E_EMAIL],
    );
  } finally {
    await db.end();
  }
}
