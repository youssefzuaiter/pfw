import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { Client } from "pg";
import { DEMO_ROW_SNAPSHOT_PATH, E2E_EMAIL, type DemoRowSnapshot } from "./global-setup";

/**
 * Puts the seeded `demo@pfw.local` row back exactly as `global-setup.ts`
 * found it — its original `passwordHash` (NULL when the seed left it
 * unclaimed; the Argon2id hash of the shared demo password when
 * `NEXT_PUBLIC_DEMO_MODE=true`, §3uu) and `displayName` — so a developer
 * running the suite locally never wakes up to a demo account that stopped
 * working, in either mode. The previous version hard-reset the row to
 * unclaimed with a hardcoded name, which silently broke Demo Login after
 * every run once the seed started pre-claiming the row.
 */
export default async function globalTeardown() {
  if (!existsSync(DEMO_ROW_SNAPSHOT_PATH)) return; // setup never got as far as taking the row over
  const snapshot = JSON.parse(readFileSync(DEMO_ROW_SNAPSHOT_PATH, "utf8")) as DemoRowSnapshot;

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query(
      'UPDATE "User" SET email = $1, "passwordHash" = $2, "displayName" = $3 WHERE id = $4',
      [E2E_EMAIL, snapshot.passwordHash, snapshot.displayName, snapshot.id],
    );
  } finally {
    await db.end();
    unlinkSync(DEMO_ROW_SNAPSHOT_PATH);
  }
}
