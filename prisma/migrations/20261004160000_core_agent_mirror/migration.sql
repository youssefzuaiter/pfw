-- A read-only mirror of the long-term core's journal, its latest account
-- snapshot and its router's self-report (ad hoc, AGENTS.md §3fff). The
-- tables are generated via `prisma migrate diff` against the live dev DB
-- (the established workaround for this history, §3p/§3s/§3eee); the RLS,
-- grant and revoke statements at the end are hand-added, as in every
-- migration since.
--
-- Apply this BEFORE (or in the same sitting as) the code that reads it
-- reaches production: the page and the webhook are written to degrade
-- when these tables are missing, but only the migration makes them work.

-- CreateTable
CREATE TABLE "CoreJournalEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "entryIndex" INTEGER NOT NULL,
    "entryHash" TEXT NOT NULL,
    "prevHash" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "planId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "rawLine" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoreJournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoreSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL,
    "equityUsdCents" BIGINT NOT NULL,
    "cashUsdCents" BIGINT NOT NULL,
    "lastEquityUsdCents" BIGINT,
    "positions" JSONB NOT NULL,
    "targets" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoreSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoreRouterStatus" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reportedAt" TIMESTAMP(3) NOT NULL,
    "tradingEnabled" BOOLEAN NOT NULL,
    "disabledReason" TEXT,
    "halted" BOOLEAN NOT NULL,
    "haltReason" TEXT,
    "policySha256" TEXT,
    "policyEffectiveFrom" TEXT,
    "planId" TEXT,
    "planKind" TEXT,
    "planStatus" TEXT,
    "planExecuteOn" TEXT,
    "journalOk" BOOLEAN NOT NULL,
    "journalEntries" INTEGER NOT NULL,
    "journalReason" TEXT,
    "tickAgeSeconds" DOUBLE PRECISION,
    "tickFailures" INTEGER NOT NULL,
    "attention" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoreRouterStatus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CoreJournalEntry_userId_occurredAt_idx" ON "CoreJournalEntry"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "CoreJournalEntry_userId_planId_idx" ON "CoreJournalEntry"("userId", "planId");

-- CreateIndex
CREATE UNIQUE INDEX "CoreJournalEntry_userId_chainId_entryIndex_key" ON "CoreJournalEntry"("userId", "chainId", "entryIndex");

-- CreateIndex
CREATE UNIQUE INDEX "CoreSnapshot_userId_takenAt_key" ON "CoreSnapshot"("userId", "takenAt");

-- CreateIndex
CREATE UNIQUE INDEX "CoreRouterStatus_userId_key" ON "CoreRouterStatus"("userId");

-- AddForeignKey
ALTER TABLE "CoreJournalEntry" ADD CONSTRAINT "CoreJournalEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoreSnapshot" ADD CONSTRAINT "CoreSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoreRouterStatus" ADD CONSTRAINT "CoreRouterStatus_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security: user-scoped like every other table that holds one
-- account's own activity, so the standard single tenant_isolation policy,
-- FORCEd so the table owner does not bypass it.
ALTER TABLE "CoreJournalEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoreJournalEntry" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "CoreJournalEntry"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "CoreSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoreSnapshot" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "CoreSnapshot"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "CoreRouterStatus" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoreRouterStatus" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "CoreRouterStatus"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- Grants are explicit rather than left to the default-privileges rule
-- (the §3uu lesson: a table the runtime role cannot touch fails as an
-- opaque 500 in production only).
GRANT SELECT, INSERT, UPDATE, DELETE ON "CoreSnapshot" TO pfw_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "CoreRouterStatus" TO pfw_runtime;

-- The journal mirror is insert-only for the web app's own role: it can
-- add an entry and read it back, and cannot rewrite or delete one. The
-- default-privileges rule grants full DML on a new table, so the revoke
-- has to come AFTER the grant. The migrating role keeps its rights (a
-- cascading user delete, test cleanup). This is defence in depth for a
-- COPY — the real record is the router's own append-only file — not the
-- trigger-enforced immutability AuditLog and LedgerCommit need for being
-- the record themselves.
GRANT SELECT, INSERT ON "CoreJournalEntry" TO pfw_runtime;
REVOKE UPDATE, DELETE ON "CoreJournalEntry" FROM pfw_runtime;
