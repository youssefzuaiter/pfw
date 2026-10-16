-- Safe to Spend follow-ups (AGENTS.md §3yyy): the day a typed balance is true
-- for, and whether savings count as spendable cash. Both additive; existing
-- rows keep the behaviour they had (balanceAsOf NULL = "when it was created",
-- savings counted).
ALTER TABLE "BankAccount" ADD COLUMN "balanceAsOf" DATE;

ALTER TABLE "UserSettings" ADD COLUMN "safeToSpendCountSavings" BOOLEAN NOT NULL DEFAULT true;
