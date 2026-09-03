-- Auth hardening pass (ad hoc, post-§3ff): password reset via time-limited
-- single-use tokens, and email verification. Hand-written, same
-- established pattern as every migration since §3p — prior hand-edited
-- migrations in this history break `prisma migrate dev`'s shadow-database
-- replay, so this SQL was generated via `prisma migrate diff` against the
-- live dev DB and the RLS block below was added by hand afterward, same
-- workflow as every migration since (see AGENTS.md §3p's "migration-
-- checksum incident").

-- AlterTable
-- Additive, nullable, no backfill needed: null means "not yet verified,"
-- correct for every existing row (the schema doc comment on this column
-- explains why it's never set at registration time).
ALTER TABLE "User" ADD COLUMN     "emailVerified" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailVerificationToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerificationToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailVerificationToken_tokenHash_key" ON "EmailVerificationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "EmailVerificationToken_userId_idx" ON "EmailVerificationToken"("userId");

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailVerificationToken" ADD CONSTRAINT "EmailVerificationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security. Both tables are user-owned, one-row-per-token data,
-- same single tenant_isolation policy shape every plain user-scoped table
-- gets (20260827133632_rls_and_runtime_role) — no "fellow member needs
-- read access" case here, unlike the Household Spaces tables (§3s).
--
-- The real, deliberate exception: the actual request/confirm flows for
-- both password reset and email verification run UNAUTHENTICATED (a
-- password-reset requester has, by definition, no session — that's why
-- they're resetting; an email-verification link can be opened from a
-- browser with no session too) and therefore have no `app.current_user_id`
-- to satisfy this policy with. Those flows use the admin (RLS-bypassing)
-- client — src/server/auth/account-recovery-admin-ops.ts, allowlisted in
-- tests/guards/admin-client-boundary.test.ts — the same "one deliberate,
-- documented, narrowly-scoped bootstrap bypass" pattern already
-- established for `getCurrentUser()`, the household/vault invite flows,
-- and `credentials.ts`'s login/registration. `pfw_runtime` already has
-- full DML on both new tables for free via the existing
-- `ALTER DEFAULT PRIVILEGES` blanket grant (§3k's ExchangeRate precedent).
ALTER TABLE "PasswordResetToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PasswordResetToken" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PasswordResetToken"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "EmailVerificationToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailVerificationToken" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "EmailVerificationToken"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));
