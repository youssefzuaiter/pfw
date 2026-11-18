/**
 * Manual entry point for the paper-row flagging sweep
 * (src/server/paper-trader/flag-existing-paper-rows.ts, AGENTS.md §3pppp).
 * `GET /api/cron` runs the same function every night; this exists to run it
 * right now and watch it.
 *
 * Run with: npm run flag:paper-rows
 */
import "dotenv/config";
import { flagExistingPaperRows } from "../src/server/paper-trader/flag-existing-paper-rows";

async function main() {
  const result = await flagExistingPaperRows();
  if (!result.ok) {
    console.error(`Flagging paper rows FAILED: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Flagged ${result.transactionsFlagged} ledger row(s) and ${result.holdingsFlagged} holding(s) as paper` +
      (result.conflicts > 0 ? `; ${result.conflicts} holding(s) left alone because a paper holding already exists in that ticker (see the log).` : "."),
  );
  if (result.conflicts > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
