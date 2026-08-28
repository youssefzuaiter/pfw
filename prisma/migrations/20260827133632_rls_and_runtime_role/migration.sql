-- Restricted runtime role + Row-Level Security (defense-in-depth on top of
-- the DAL's own `where: { userId }` scoping — see docs/SECURITY.md).
--
-- `pfw_app` (the role every `prisma migrate` command runs as, per
-- prisma.config.ts / DATABASE_URL) is a superuser, because that's what the
-- official `postgres` Docker image makes the role named by POSTGRES_USER.
-- Superusers and table owners bypass RLS entirely regardless of policy
-- definitions, so RLS is meaningless unless the application connects as a
-- *different*, unprivileged role. `pfw_runtime` is that role: it owns
-- nothing, cannot bypass RLS, and only has DML privileges (no DDL). The
-- Next.js app's actual runtime PrismaClient (src/server/db/client.ts)
-- connects via APP_DATABASE_URL, using pfw_runtime — never pfw_app.
--
-- LOCAL DEV NOTE: the password below is a throwaway local credential, same
-- as pfw_app's in compose.yaml. A Tier 3 deployment manages this role via
-- the hosting provider's secret management, not a checked-in migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pfw_runtime') THEN
    CREATE ROLE pfw_runtime
      LOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOBYPASSRLS
      CONNECTION LIMIT 20
      PASSWORD 'pfw_runtime_dev_password';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO pfw_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pfw_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pfw_runtime;

-- Future tables/sequences created by later migrations (run as pfw_app)
-- automatically grant the same privileges to pfw_runtime.
ALTER DEFAULT PRIVILEGES FOR ROLE pfw_app IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pfw_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE pfw_app IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO pfw_runtime;

-- AuditLog is append-only: pfw_runtime may SELECT and INSERT, never
-- UPDATE/DELETE. Privilege-based enforcement is the primary control;
-- the trigger below is a second, independent layer in case grants are
-- ever misconfigured.
REVOKE UPDATE, DELETE ON "AuditLog" FROM pfw_runtime;

CREATE OR REPLACE FUNCTION prevent_audit_log_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_append_only ON "AuditLog";
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();

-- Row-Level Security. Every policy is keyed on the session variable
-- `app.current_user_id`, set per-request by src/server/db/with-user-scope.ts
-- via `SELECT set_config('app.current_user_id', $1, true)` inside the same
-- transaction as the query it scopes. `current_setting(..., true)` returns
-- NULL when unset, and "column = NULL" is never true in SQL — so a
-- forgotten scope call fails closed (zero rows visible/writable), not
-- open.
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "User"
  USING ("id" = current_setting('app.current_user_id', true))
  WITH CHECK ("id" = current_setting('app.current_user_id', true));

ALTER TABLE "Category" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Category" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Category"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "BankAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BankAccount" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "BankAccount"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "NotableTransaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotableTransaction" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "NotableTransaction"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "Budget" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Budget" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Budget"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "Goal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Goal" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Goal"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "GoalContribution" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GoalContribution" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "GoalContribution"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "Debt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Debt" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Debt"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "DebtPayment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DebtPayment" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "DebtPayment"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "ManualAsset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ManualAsset" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ManualAsset"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "PortfolioHolding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PortfolioHolding" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PortfolioHolding"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "Trade" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Trade" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Trade"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "NetWorthSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NetWorthSnapshot" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "NetWorthSnapshot"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "MerchantEmbedding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MerchantEmbedding" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "MerchantEmbedding"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AuditLog"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));
