-- First-run setup wizard (AGENTS.md §3zzz): when the user finished or skipped it.
-- Additive and nullable; no backfill, because the wizard only runs for a user whose
-- app is still empty, so existing users are never sent to it.
ALTER TABLE "UserSettings" ADD COLUMN "onboardingCompletedAt" TIMESTAMP(3);
