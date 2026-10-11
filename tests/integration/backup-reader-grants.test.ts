import { afterAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";

/**
 * The nightly backup runs `pg_dump` as `backup_reader`, and one table it
 * cannot SELECT fails the whole dump. That happened in production from
 * 2026-10-05: a migration created three tables and granted only the app role
 * on them, leaving the backup role to default privileges that did not apply
 * there. Seven nights of backups were lost before anyone looked.
 *
 * This asserts the invariant itself, so a migration that adds a table
 * without reaching backup_reader fails here instead of in the middle of the
 * night. It cannot reproduce production's role setup (locally the defaults
 * fire), but it does catch any table that neither a default nor an explicit
 * grant covers.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("backup_reader grants", () => {
  const admin = createAdminClient();

  afterAll(async () => {
    await admin.$disconnect();
  });

  it("can SELECT every table in the public schema", async () => {
    const unreadable = await admin.$queryRaw<{ table_name: string }[]>`
      SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND NOT has_table_privilege('backup_reader', c.oid, 'SELECT')
      ORDER BY c.relname`;
    expect(unreadable.map((row) => row.table_name)).toEqual([]);
  });

  it("is read-only: it holds no write privilege on any table", async () => {
    const writable = await admin.$queryRaw<{ table_name: string }[]>`
      SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND (has_table_privilege('backup_reader', c.oid, 'INSERT')
          OR has_table_privilege('backup_reader', c.oid, 'UPDATE')
          OR has_table_privilege('backup_reader', c.oid, 'DELETE'))
      ORDER BY c.relname`;
    expect(writable.map((row) => row.table_name)).toEqual([]);
  });
});
