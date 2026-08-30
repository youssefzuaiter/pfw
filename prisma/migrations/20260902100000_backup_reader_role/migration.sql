-- Read-only, cert-auth-only role for the logical backup CronJob
-- (k8s/db/db-backup-cronjob.yaml). Companion to
-- 20260827133632_rls_and_runtime_role's pfw_runtime: same pattern
-- (idempotent creation, ALTER DEFAULT PRIVILEGES for future tables), but
-- deliberately different privileges.
--
-- No PASSWORD clause at all: password auth is impossible for this role,
-- not merely undocumented. In production, k8s/db/postgres-cluster.yaml's
-- pg_hba routes it to `cert` auth exclusively (mTLS client certificate,
-- CN=backup_reader, issued by k8s/db/postgres-cluster.yaml's cert-manager
-- Certificate) — there is no credential for this role to leak.
--
-- BYPASSRLS is required, not incidental: pg_dump must see every tenant's
-- rows to produce a restorable backup. Every table below has
-- `FORCE ROW LEVEL SECURITY` (see 20260827133632_rls_and_runtime_role),
-- which means even the table owner is subject to RLS — without
-- BYPASSRLS, `app.current_user_id` would be unset for a cron job with no
-- request context, and per that migration's fail-closed design every
-- policy would evaluate to zero rows, producing a silently empty backup.
-- SELECT-only (no INSERT/UPDATE/DELETE, no DDL) keeps the role read-only
-- despite the RLS bypass.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backup_reader') THEN
    CREATE ROLE backup_reader
      LOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      BYPASSRLS
      CONNECTION LIMIT 3;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO backup_reader;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO backup_reader;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO backup_reader;

-- Future tables/sequences created by later migrations (run as pfw_app)
-- automatically grant SELECT to backup_reader too.
ALTER DEFAULT PRIVILEGES FOR ROLE pfw_app IN SCHEMA public
  GRANT SELECT ON TABLES TO backup_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE pfw_app IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO backup_reader;
