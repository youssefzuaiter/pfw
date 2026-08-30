-- Cryptographic Dead Man's Switch (AGENTS.md §3t).
--
-- Schema DDL below generated via `prisma migrate diff` against the live
-- dev database (`prisma migrate dev` refuses to run non-interactively:
-- two prior migrations in this history were hand-edited after being
-- applied — see AGENTS.md §3p's "migration-checksum incident" — which
-- invalidates the shadow-database replay `migrate dev` needs; diffing
-- the live database directly sidesteps that with no data loss, same
-- precedent as the household-spaces migration). Everything from the
-- "Row-Level Security" comment onward is hand-written, same established
-- pattern as every other migration in this history that touches RLS.

-- CreateEnum
CREATE TYPE "DeadMansSwitchStatus" AS ENUM ('ACTIVE', 'GRACE_PERIOD', 'TRIGGERED', 'RECOVERED');

-- CreateTable
CREATE TABLE "DeadMansSwitch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "DeadMansSwitchStatus" NOT NULL DEFAULT 'ACTIVE',
    "inactivityThresholdDays" INTEGER NOT NULL DEFAULT 90,
    "gracePeriodDays" INTEGER NOT NULL DEFAULT 14,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "graceStartedAt" TIMESTAMP(3),
    "triggeredAt" TIMESTAMP(3),
    "recoveredAt" TIMESTAMP(3),
    "totalShares" INTEGER NOT NULL,
    "thresholdShares" INTEGER NOT NULL,
    "vaultSalt" TEXT NOT NULL,
    "vaultKdfIterations" INTEGER NOT NULL,
    "vaultCanaryCiphertext" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeadMansSwitch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Beneficiary" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deadMansSwitchId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "shareIndex" INTEGER NOT NULL,
    "shareHash" TEXT NOT NULL,
    "inviteTokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Beneficiary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencyDocument" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deadMansSwitchId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmergencyDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryShareSubmission" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deadMansSwitchId" TEXT NOT NULL,
    "beneficiaryId" TEXT NOT NULL,
    "shareValueCiphertext" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryShareSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeadMansSwitch_userId_key" ON "DeadMansSwitch"("userId");

-- CreateIndex
CREATE INDEX "DeadMansSwitch_status_idx" ON "DeadMansSwitch"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Beneficiary_inviteTokenHash_key" ON "Beneficiary"("inviteTokenHash");

-- CreateIndex
CREATE INDEX "Beneficiary_userId_idx" ON "Beneficiary"("userId");

-- CreateIndex
CREATE INDEX "Beneficiary_deadMansSwitchId_idx" ON "Beneficiary"("deadMansSwitchId");

-- CreateIndex
CREATE UNIQUE INDEX "Beneficiary_deadMansSwitchId_shareIndex_key" ON "Beneficiary"("deadMansSwitchId", "shareIndex");

-- CreateIndex
CREATE INDEX "EmergencyDocument_userId_idx" ON "EmergencyDocument"("userId");

-- CreateIndex
CREATE INDEX "EmergencyDocument_deadMansSwitchId_idx" ON "EmergencyDocument"("deadMansSwitchId");

-- CreateIndex
CREATE INDEX "RecoveryShareSubmission_userId_idx" ON "RecoveryShareSubmission"("userId");

-- CreateIndex
CREATE INDEX "RecoveryShareSubmission_deadMansSwitchId_idx" ON "RecoveryShareSubmission"("deadMansSwitchId");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryShareSubmission_deadMansSwitchId_beneficiaryId_key" ON "RecoveryShareSubmission"("deadMansSwitchId", "beneficiaryId");

-- AddForeignKey
ALTER TABLE "DeadMansSwitch" ADD CONSTRAINT "DeadMansSwitch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Beneficiary" ADD CONSTRAINT "Beneficiary_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Beneficiary" ADD CONSTRAINT "Beneficiary_deadMansSwitchId_fkey" FOREIGN KEY ("deadMansSwitchId") REFERENCES "DeadMansSwitch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyDocument" ADD CONSTRAINT "EmergencyDocument_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyDocument" ADD CONSTRAINT "EmergencyDocument_deadMansSwitchId_fkey" FOREIGN KEY ("deadMansSwitchId") REFERENCES "DeadMansSwitch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryShareSubmission" ADD CONSTRAINT "RecoveryShareSubmission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryShareSubmission" ADD CONSTRAINT "RecoveryShareSubmission_deadMansSwitchId_fkey" FOREIGN KEY ("deadMansSwitchId") REFERENCES "DeadMansSwitch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryShareSubmission" ADD CONSTRAINT "RecoveryShareSubmission_beneficiaryId_fkey" FOREIGN KEY ("beneficiaryId") REFERENCES "Beneficiary"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================
-- Row-Level Security
-- =====================================================================
--
-- All four tables get the standard single tenant_isolation policy every
-- plain user-owned table gets (20260827133632_rls_and_runtime_role) —
-- unlike the Household Spaces migration, there is no "fellow member
-- needs read access" case here to justify a 4-policy split.
--
-- The anonymous beneficiary recovery flow (a person holding an invite
-- token and a share, who is by definition NOT the authenticated vault
-- owner and has no row-level standing under `tenant_isolation` at all)
-- does not get a carve-out IN these policies — it goes around RLS
-- entirely via the admin (RLS-bypassing) client, exactly the same
-- pattern `GroupInvite`'s accept flow already established
-- (src/server/groups/invite-admin-ops.ts, AGENTS.md §3s): a narrow,
-- isolated, explicitly allowlisted set of functions
-- (src/server/dead-mans-switch/recovery-admin-ops.ts) is the only place
-- in the whole app that reads a Beneficiary by token hash or writes a
-- RecoveryShareSubmission on someone else's behalf. Every owner-side
-- operation (setup, adding beneficiaries/documents, checking recovery
-- progress, cancelling a triggered recovery) goes through the normal
-- withUserScope-scoped DAL path and is fully RLS-covered like everything
-- else in this app.
ALTER TABLE "DeadMansSwitch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DeadMansSwitch" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "DeadMansSwitch"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "Beneficiary" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Beneficiary" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Beneficiary"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "EmergencyDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmergencyDocument" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "EmergencyDocument"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "RecoveryShareSubmission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RecoveryShareSubmission" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "RecoveryShareSubmission"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

