-- Two-phase paper-trade settlement (ad hoc, extends the Tier-0 agent
-- integration). Generated via `prisma migrate diff` against the live dev
-- DB — same established workaround as every migration since §3p, since
-- prior hand-edited migrations in this history break `prisma migrate
-- dev`'s shadow-database replay. No RLS change needed here (unlike most
-- migrations that hit this same workaround): this is a plain enum +
-- column addition on `Trade`, which already has RLS `FORCE`d and a
-- `tenant_isolation` policy keyed on `userId` alone — unaffected by an
-- unrelated column.
--
-- Additive, NOT NULL with a default: safe against the existing non-empty
-- `Trade` table because every historical row genuinely WAS already
-- settled by the time this migration runs — the DAL backfills each of
-- those rows to `SETTLED` explicitly (see the follow-up statement below),
-- so the schema default of `PENDING` only ever actually applies to a
-- freshly INSERTed row from the async paper-trading-agent path.

-- CreateEnum
CREATE TYPE "TradeStatus" AS ENUM ('PENDING', 'SETTLED', 'CANCELED');

-- AlterTable
ALTER TABLE "Trade" ADD COLUMN     "status" "TradeStatus" NOT NULL DEFAULT 'PENDING';

-- Backfill: every Trade row that existed before this migration already
-- represents a completed execution (the synchronous /api/trades route,
-- the seed script, and every pre-refactor paper-trading webhook receipt
-- all booked a trade only once it was already final) — none of them were
-- ever part of the new PENDING/SETTLED lifecycle, so leaving them at the
-- column default would misrepresent them as still-open orders.
UPDATE "Trade" SET "status" = 'SETTLED';
