/**
 * Manual entry point for the exchange-rate history sync (AGENTS.md §3vvv).
 * `GET /api/cron` runs the same function every night; this exists so an
 * operator can fill the history now, for example on a fresh local database.
 *
 * Run with: npm run sync:rates:history
 *
 * Needs `--conditions=react-server` like every script that reaches into
 * src/server/** (see AGENTS.md's deviations list).
 */
import "dotenv/config";
import { syncRateHistory } from "../src/server/currency/rate-sync";

async function main() {
  const result = await syncRateHistory();
  if (!result.ok) {
    console.error(`Exchange rate history sync FAILED: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Rate history ${result.from}..${result.to}: ${result.fetched} rate(s) fetched, ${result.added} new day(s) stored.`);
}

main().catch((error) => {
  console.error("Exchange rate history sync FAILED:", error);
  process.exitCode = 1;
});
