-- Grants that survive a migrator that is not `pfw_app` (AGENTS.md §3yy).
--
-- 20260827133632_rls_and_runtime_role and 20260902100000_backup_reader_role
-- both declared their forward-looking grants as
--   ALTER DEFAULT PRIVILEGES FOR ROLE pfw_app ...
-- which only ever covers objects that `pfw_app` itself creates. Locally
-- that is every table (compose.yaml's POSTGRES_USER is pfw_app). On the
-- production (Neon) database `prisma migrate deploy` runs as the project
-- owner role instead, so every table created since those migrations got
-- NO automatic grant: §3uu had to hand-apply pfw_runtime's DML on
-- RateLimitBucket, 20260918120000_equity_quotes repeated the grant inline,
-- and backup_reader — whose one job is `pg_dump` — cannot read any of the
-- 15 tables created after 2026-09-02, which aborts a backup on the first
-- of them ("permission denied for table UserSettings").
--
-- Two fixes, both idempotent, both no-ops where nothing was missing:
--   1. A catch-up grant across every table that exists right now.
--   2. Default privileges declared WITHOUT `FOR ROLE`, so they attach to
--      whichever role is running THIS migration — the same role that runs
--      every later one on that environment — instead of a role that may
--      never create a table there.
-- The catch-up re-grants UPDATE/DELETE on the two append-only tables, so
-- their REVOKEs (the first enforcement layer; the triggers are the second,
-- and hold regardless) are re-issued at the end, verbatim from their own
-- migrations. Verified after applying: only AuditLog and LedgerCommit lack
-- UPDATE for pfw_runtime, backup_reader can SELECT every table.
--
-- No PASSWORD clause anywhere, on purpose: backup_reader's credential is
-- set once, by hand, per environment (docs/BACKUP-RESTORE.md) — a
-- migration file is committed to a public repository.

GRANT USAGE ON SCHEMA public TO pfw_runtime, backup_reader;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pfw_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pfw_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO backup_reader;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO backup_reader;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pfw_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO pfw_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO backup_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO backup_reader;

REVOKE UPDATE, DELETE ON "AuditLog" FROM pfw_runtime;
REVOKE UPDATE, DELETE ON "LedgerCommit" FROM pfw_runtime;
