import "server-only";
import { createAdminClient } from "../db/admin-client";

/**
 * Flags the paper-trader rows that were written before `isPaper` existed
 * (AGENTS.md §3pppp), nightly from GET /api/cron and by hand with
 * `npm run flag:paper-rows`.
 *
 * The migration does the same backfill when its role can see every user's
 * rows. This is the second path for when it cannot (the tables have forced
 * row-level security, where an UPDATE under a role that cannot bypass it
 * matches nothing and still succeeds), and the net for a paper receipt that
 * arrives between the deploy and the migration. Idempotent, and a cheap
 * no-op once nothing is left.
 *
 * An admin-client exception (allowlisted), the legacy-plaintext sweep's
 * shape: rows of every user, no session, no single userId. It never reads or
 * writes an encrypted column.
 *
 * One case it will not decide for itself: a legacy holding that qualifies as
 * paper while the same user already has a paper holding in that ticker. That
 * happens when a receipt arrived after the deploy but before this ran, so
 * the position is split across two rows. Merging them would mean choosing
 * between two cost bases, so the sweep counts it as `conflicts`, logs it, and
 * leaves both rows for a person to look at.
 *
 * Never throws.
 */
export type FlagPaperRowsResult =
  | { ok: true; transactionsFlagged: number; holdingsFlagged: number; conflicts: number }
  | { ok: false; error: string };

/** A holding is a paper position when the paper trader built it. See the migration for why each test is sound. */
const PAPER_HOLDING_TEST = `
  (
    EXISTS (SELECT 1 FROM "HoldingLot" l WHERE l."holdingId" = h."id")
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
    )
  )`;

export async function flagExistingPaperRows(): Promise<FlagPaperRowsResult> {
  const admin = createAdminClient();
  try {
    const transactionsFlagged = await admin.$executeRawUnsafe(
      `UPDATE "NotableTransaction" SET "isPaper" = true
       WHERE "isPaper" = false AND "providerTransactionId" LIKE 'paper-trade:%'`,
    );

    const holdingsFlagged = await admin.$executeRawUnsafe(
      `UPDATE "PortfolioHolding" h SET "isPaper" = true
       WHERE h."isPaper" = false
         AND ${PAPER_HOLDING_TEST}
         AND NOT EXISTS (
           SELECT 1 FROM "PortfolioHolding" twin
           WHERE twin."userId" = h."userId" AND twin."symbol" = h."symbol" AND twin."isPaper" = true
         )`,
    );

    const conflictRows = await admin.$queryRawUnsafe<{ userId: string; symbol: string }[]>(
      `SELECT h."userId", h."symbol" FROM "PortfolioHolding" h
       WHERE h."isPaper" = false
         AND ${PAPER_HOLDING_TEST}
         AND EXISTS (
           SELECT 1 FROM "PortfolioHolding" twin
           WHERE twin."userId" = h."userId" AND twin."symbol" = h."symbol" AND twin."isPaper" = true
         )`,
    );
    for (const row of conflictRows) {
      console.error(
        `flag-existing-paper-rows: user ${row.userId} has two holdings in ${row.symbol} that both look like paper positions; left as they are`,
      );
    }

    return { ok: true, transactionsFlagged, holdingsFlagged, conflicts: conflictRows.length };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await admin.$disconnect();
  }
}
