-- Phone alerts through ntfy (AGENTS.md §3qqq): one subscription row per
-- user who turned them on. `topic` is AES-256-GCM ciphertext written by the
-- app's field-encryption extension; this migration never sees a plaintext.

-- CreateTable
CREATE TABLE "PhoneAlertSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "largeExpenseAgorot" BIGINT NOT NULL DEFAULT 100000,
    "includeDetails" BOOLEAN NOT NULL DEFAULT true,
    "lastCheckedAt" TIMESTAMP(3),
    "overdrawnCategoryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "importReminderSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhoneAlertSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PhoneAlertSubscription_userId_key" ON "PhoneAlertSubscription"("userId");

-- AddForeignKey
ALTER TABLE "PhoneAlertSubscription" ADD CONSTRAINT "PhoneAlertSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Per-user data: the standard single tenant_isolation policy, FORCEd so the
-- table owner does not bypass it.
ALTER TABLE "PhoneAlertSubscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PhoneAlertSubscription" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PhoneAlertSubscription"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- Both grants stated outright. Default privileges attach only to the role
-- that declared them, and on production the migrating role is not that role:
-- the §3uu outage (pfw_runtime) and the 2026-10-05 backup failure
-- (backup_reader, 20261011160000_backup_reader_core_tables) both came from
-- leaning on them.
GRANT SELECT, INSERT, UPDATE, DELETE ON "PhoneAlertSubscription" TO pfw_runtime;
GRANT SELECT ON "PhoneAlertSubscription" TO backup_reader;
