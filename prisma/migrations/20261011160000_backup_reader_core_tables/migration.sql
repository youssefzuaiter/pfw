-- The nightly backup has failed since 2026-10-05 with
--   pg_dump: error: query failed: ERROR: permission denied for table "CoreJournalEntry"
-- because backup_reader had no SELECT on the three tables
-- 20261004160000_core_agent_mirror created on production.
--
-- That migration granted pfw_runtime on its new tables explicitly but left
-- backup_reader to ALTER DEFAULT PRIVILEGES, and on production the default
-- did not fire for tables created by the role that ran it (it did locally,
-- where the migrating role and the default's role are the same, which is
-- why nothing showed before). Default privileges only attach to the role
-- that declared them, so they are the wrong thing to lean on for a role
-- whose whole job is to read every table.
--
-- State the grant outright, for every table that exists now, and re-declare
-- the defaults for whichever role runs this migration. SELECT only, and
-- nothing here touches pfw_runtime: re-granting it ON ALL TABLES would give
-- back the UPDATE/DELETE that AuditLog, LedgerCommit and CoreJournalEntry
-- deliberately lack.
--
-- No PASSWORD clause, as in every other backup_reader migration: its
-- credential is set by hand and lives only in the `backup` GitHub
-- environment and the password manager.

GRANT USAGE ON SCHEMA public TO backup_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO backup_reader;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO backup_reader;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO backup_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO backup_reader;
