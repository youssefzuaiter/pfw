-- Paper-trader money is practice money (AGENTS.md §3pppp). Two flags keep it
-- out of every real total:
--   PortfolioHolding.isPaper — a position the paper trader built. Part of the
--     unique key, so a paper position and a simulated-desk position in the same
--     ticker are separate rows instead of one mixed quantity.
--   NotableTransaction.isPaper — the ledger row a paper fill wrote.
--
-- Rows that already exist are flagged at the end of this file, but only when the
-- migrating role can see every user's rows: the tables have FORCED row-level
-- security, and for a role that cannot bypass it an UPDATE matches nothing and
-- "succeeds". In that case the flagging is left to the nightly cron
-- (src/server/paper-trader/flag-existing-paper-rows.ts, also runnable by hand
-- with `npm run flag:paper-rows`), which is idempotent and does the same thing.

-- DropIndex
DROP INDEX "PortfolioHolding_userId_symbol_key";

-- AlterTable
ALTER TABLE "NotableTransaction" ADD COLUMN     "isPaper" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PortfolioHolding" ADD COLUMN     "isPaper" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioHolding_userId_symbol_isPaper_key" ON "PortfolioHolding"("userId", "symbol", "isPaper");

-- Backfill. A ledger row is a paper row when it carries the paper trader's key
-- prefix. A holding is a paper position when the paper trader built it: it has
-- a per-lot record (only the paper path writes those), a trade that never
-- settled (only the paper path creates pending trades), or a trade whose key
-- appears on a paper ledger row. A holding that mixes simulated-desk and paper
-- trades in one ticker becomes wholly paper; the two could not be told apart
-- before this column existed.
DO $$
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE NOTICE 'paper_trades_flag: % cannot bypass row-level security, so existing rows are left to the nightly flagging job', current_user;
    RETURN;
  END IF;

  UPDATE "NotableTransaction" SET "isPaper" = true WHERE "providerTransactionId" LIKE 'paper-trade:%';

  UPDATE "PortfolioHolding" h SET "isPaper" = true
  WHERE EXISTS (SELECT 1 FROM "HoldingLot" l WHERE l."holdingId" = h."id")
     OR EXISTS (
       SELECT 1 FROM "Trade" t
       WHERE t."portfolioHoldingId" = h."id"
         AND (
           t."status" <> 'SETTLED'
           OR EXISTS (
             SELECT 1 FROM "NotableTransaction" n
             WHERE n."userId" = t."userId" AND n."providerTransactionId" = 'paper-trade:' || t."idempotencyKey"
           )
         )
     );
END
$$;
