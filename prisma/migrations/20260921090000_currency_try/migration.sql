-- AlterEnum: TRY (Turkish lira) — the first currency added for a real
-- account rather than the mock trading desk (AGENTS.md §3bbb).
--
-- This file deliberately contains ONLY the enum change. Postgres allows
-- ADD VALUE inside a transaction (PG >= 12) but forbids USING the new
-- value in the same transaction — and Prisma runs each migration file as
-- one transaction — so any backfill/default that references 'TRY' must
-- live in a later migration. IF NOT EXISTS makes a re-run harmless.
ALTER TYPE "Currency" ADD VALUE IF NOT EXISTS 'TRY';
