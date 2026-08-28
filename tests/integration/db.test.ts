import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Proves the DB-integration harness can reach the `pfw_local` Postgres
 * container defined in compose.yaml. Real schema/repository integration
 * tests (including the negative-IDOR suite) land in Phase 2 once the
 * Prisma schema and DAL exist.
 *
 * Skipped when DATABASE_URL isn't set, e.g. in a checkout where
 * `docker compose up` hasn't been run yet — this suite is not meant to
 * block Phase 1 verification on a running database.
 */
describe.skipIf(!process.env.DATABASE_URL)("pfw_local connectivity", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  it("connects and reports the expected database name", async () => {
    const result = await client.query<{ current_database: string }>(
      "select current_database()",
    );
    expect(result.rows[0]?.current_database).toBe("pfw_local");
  });

  it("runs a trivial query", async () => {
    const result = await client.query<{ answer: number }>("select 1 as answer");
    expect(result.rows[0]?.answer).toBe(1);
  });
});
