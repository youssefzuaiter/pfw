-- Zero-knowledge vault for GoalContribution.note (AGENTS.md §3m). None of
-- these three columns are secret: a PBKDF2 salt and iteration count are
-- meant to be public, and the canary is a known constant encrypted under
-- the derived key, used only to verify a re-entered passphrase. All null
-- (the default for every existing row) means the vault has never been
-- set up. Already covered by User's existing RLS policy — new nullable
-- columns on an already-policy-covered table need no additional grant.
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "zkCanaryCiphertext" TEXT,
ADD COLUMN     "zkKdfIterations" INTEGER,
ADD COLUMN     "zkSalt" TEXT;
