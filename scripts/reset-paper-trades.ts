/**
 * One-off cleanup script: wipes the Tier-0 paper-trading agent's test
 * data for `PAPER_TRADING_USER_ID` so the demo account's paper portfolio
 * starts clean again.
 *
 * Run with: npm run reset:paper-trades
 *   (equivalent to: npx tsx --conditions=react-server scripts/reset-paper-trades.ts)
 *
 * Deliberately placed under the repo-root `scripts/` directory, NOT
 * `src/scripts/` — `tests/guards/admin-client-boundary.test.ts` only
 * walks `src/`, and every existing maintenance script that needs the
 * RLS-bypassing admin client (`backfill-embeddings.ts`,
 * `sync-crypto-prices.ts`, `sync-exchange-rates.ts`) already lives here
 * for that exact reason (AGENTS.md §3ee). `--conditions=react-server` is
 * required because `admin-client.ts` is `server-only`-guarded — a plain
 * `tsx` invocation with no flag throws before this script ever runs, the
 * same deviation documented in AGENTS.md §6 for `prisma db seed`.
 *
 * SCOPE: deletes exactly the three tables named — `NotableTransaction`
 * (scoped to the `paper-trading` category, never another category, per
 * the "don't touch transactions outside paper-trading" constraint),
 * `LedgerCommit` (cascade-deleted with its parent `NotableTransaction`,
 * see below), and `Trade` (every row for this user — this account's
 * entire trade history comes from the Tier-0 agent, so there is no
 * narrower "paper-trading" subset of Trade to distinguish it from).
 *
 * NOT touched, on purpose, flagged rather than silently done: this does
 * NOT reset `PortfolioHolding.quantity`/cost-basis. That row stores a
 * running weighted-average position independently of `Trade` history
 * (AGENTS.md §3l — "a fully-liquidated PortfolioHolding is kept at
 * quantity 0, never deleted"), so wiping every `Trade` row without also
 * touching it leaves a stale nonzero holding with no trades behind it.
 * The task named exactly three tables; zeroing the holding wasn't asked
 * for, so it's left as-is rather than silently expanding scope — rerun
 * with a follow-up if a clean holding is also wanted.
 *
 * TRIGGER HANDLING: `LedgerCommit` is append-only — a `BEFORE
 * UPDATE OR DELETE` trigger (`ledger_commit_append_only`) rejects
 * mutation even for the `pfw_app` superuser (AGENTS.md §3mm), and
 * `LedgerCommit.transaction` cascade-deletes with its `NotableTransaction`
 * parent — a cascade DELETE still fires the child table's own trigger
 * (§3mm, §3z), so deleting `NotableTransaction` rows here would fail
 * outright unless the trigger is disabled first. Same established
 * pattern as `tests/integration/ledger-commit-test-helpers.ts` and
 * `prisma/seed/index.ts`'s identical handling for `AuditLog`: disable +
 * delete + re-enable inside ONE transaction, so `ALTER TABLE`'s
 * ACCESS EXCLUSIVE lock serializes any concurrent caller instead of
 * racing it, and a thrown error rolls the disable back too.
 */
import "dotenv/config";
import { createAdminClient } from "../src/server/db/admin-client";
import { getPaperTradingUserId } from "../src/server/env";
import { PAPER_TRADING_CATEGORY_SLUG } from "../src/server/dal/paper-trades";

async function main() {
  const userId = getPaperTradingUserId();
  if (!userId) {
    console.error("PAPER_TRADING_USER_ID is not set in .env — nothing to reset.");
    process.exitCode = 1;
    return;
  }

  const admin = createAdminClient();

  const category = await admin.category.findUnique({
    where: { userId_slug: { userId, slug: PAPER_TRADING_CATEGORY_SLUG } },
    select: { id: true, name: true },
  });

  if (!category) {
    console.log(
      `No "${PAPER_TRADING_CATEGORY_SLUG}" category exists yet for user ${userId} — nothing to reset.`,
    );
    return;
  }

  const [transactionCount, ledgerCommitCount, tradeCount] = await admin.$transaction(
    async (tx) => {
      // Scoped to (userId, categoryId) so a category-slug collision on a
      // different user, or any other category, can never be touched —
      // the explicit "don't touch transactions outside paper-trading"
      // constraint, enforced at the query level, not by convention alone.
      const targetTransactionIds = (
        await tx.notableTransaction.findMany({
          where: { userId, categoryId: category.id },
          select: { id: true },
        })
      ).map((row) => row.id);

      const ledgerCommitsBefore = await tx.ledgerCommit.count({
        where: { transactionId: { in: targetTransactionIds } },
      });

      await tx.$executeRaw`ALTER TABLE "LedgerCommit" DISABLE TRIGGER ledger_commit_append_only`;

      // LedgerCommit rows cascade-delete with their NotableTransaction
      // parent (onDelete: Cascade) — deleting the transactions is what
      // actually removes both tables' rows here.
      const { count: deletedTransactions } = await tx.notableTransaction.deleteMany({
        where: { id: { in: targetTransactionIds } },
      });

      const { count: deletedTrades } = await tx.trade.deleteMany({
        where: { userId },
      });

      await tx.$executeRaw`ALTER TABLE "LedgerCommit" ENABLE TRIGGER ledger_commit_append_only`;

      return [deletedTransactions, ledgerCommitsBefore, deletedTrades] as const;
    },
    { timeout: 15_000, maxWait: 15_000 },
  );

  console.log(`Reset complete for user ${userId}, category "${category.name}":`);
  console.log(`  NotableTransaction rows deleted: ${transactionCount}`);
  console.log(`  LedgerCommit rows deleted (cascaded): ${ledgerCommitCount}`);
  console.log(`  Trade rows deleted: ${tradeCount}`);
}

main()
  .catch((error) => {
    console.error("reset-paper-trades failed:", error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
