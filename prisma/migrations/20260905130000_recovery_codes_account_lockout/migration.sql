-- AlterTable
ALTER TABLE "User" ADD COLUMN     "accountLockedAt" TIMESTAMP(3),
ADD COLUMN     "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "RecoveryCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryCode_codeHash_key" ON "RecoveryCode"("codeHash");

-- CreateIndex
CREATE INDEX "RecoveryCode_userId_used_idx" ON "RecoveryCode"("userId", "used");

-- AddForeignKey
ALTER TABLE "RecoveryCode" ADD CONSTRAINT "RecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- Row-Level Security, same tenant_isolation shape every user-scoped
-- table in this app gets (AGENTS.md §2a). The actual redemption flow
-- (verifying a submitted code and marking it used) runs UNAUTHENTICATED,
-- like PasswordResetToken/EmailVerificationToken, and goes through the
-- admin-client bootstrap exception in
-- src/server/auth/recovery-code-admin-ops.ts for that reason — this
-- policy is what protects the AUTHENTICATED generation path instead
-- (src/server/dal/recovery-codes.ts, called during MFA setup).
ALTER TABLE "RecoveryCode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RecoveryCode" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "RecoveryCode"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));
