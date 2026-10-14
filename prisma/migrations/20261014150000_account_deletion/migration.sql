-- Account deletion (AGENTS.md §3ttt).
--
-- 1. AuditLog and LedgerCommit stay append-only, with one narrow exception:
--    a DELETE is allowed only while an account deletion is in progress for
--    that row's owner. Both conditions must hold:
--      - the transaction has set `pfw.purge_user_id` to the row's userId
--        (transaction-local, set_config(..., true)), and
--      - that user's own row is already gone, i.e. this delete is the cascade
--        from deleting the User row, not a direct delete of history.
--    UPDATE is still rejected unconditionally, and so is any other delete.
--    This replaces `ALTER TABLE ... DISABLE TRIGGER`, which locks the whole
--    table for every user and leaves it unprotected while it runs.
--
-- 2. AccountDeletionRecord keeps the ids of deleted accounts (a random cuid
--    and a date, nothing else), so that if an older backup is ever restored
--    those accounts can be deleted again. Not user data: the app's runtime
--    role cannot read it.

CREATE OR REPLACE FUNCTION pfw_is_account_purge(row_user_id TEXT) RETURNS boolean AS $$
BEGIN
  IF row_user_id IS NULL OR current_setting('pfw.purge_user_id', true) IS DISTINCT FROM row_user_id THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = row_user_id);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_audit_log_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pfw_is_account_purge(OLD."userId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'AuditLog is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_ledger_commit_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pfw_is_account_purge(OLD."userId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'LedgerCommit is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

-- CreateTable
CREATE TABLE "AccountDeletionRecord" (
    "id" TEXT NOT NULL,
    "deletedUserId" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountDeletionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountDeletionRecord_deletedUserId_key" ON "AccountDeletionRecord"("deletedUserId");

-- Only the deletion service (admin role) and the backup role touch this.
-- The default-privileges rule gives the runtime role full DML on a new table,
-- so it is taken away again here.
REVOKE ALL ON "AccountDeletionRecord" FROM pfw_runtime;
GRANT SELECT ON "AccountDeletionRecord" TO backup_reader;
