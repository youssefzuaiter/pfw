/**
 * Manual/cron entry point for the daily exchange-rate sync
 * (src/server/currency/rate-sync.ts).
 *
 * Run with: npm run sync:rates
 *
 * Needs `--conditions=react-server` like every other standalone script
 * that reaches into src/server/** — see AGENTS.md's deviations list.
 */
import "dotenv/config";
import { syncExchangeRates } from "../src/server/currency/rate-sync";
import { getLatestRateTable } from "../src/server/dal/exchange-rates";
import { StaleDataError } from "../src/server/stale-data-error";

async function main() {
  const result = await syncExchangeRates();

  if (!result.ok) {
    // A failed sync is not fatal: every consumer falls back to the last
    // stored rate, or FALLBACK_RATE_TABLE. Report it and exit non-zero so
    // a scheduler can alert, but never leave the app in a broken state.
    console.error(`Exchange rate sync FAILED (${result.source}): ${result.error}`);
    console.error("Consumers will continue using the last stored rate, or the built-in fallback table.");
    process.exitCode = 1;
    return;
  }

  console.log(`Exchange rate sync OK — source: ${result.source}`);
  for (const rate of result.synced) {
    console.log(`  1 ${rate.currency} = ${rate.rate.toFixed(4)} ILS  (as of ${rate.asOfDate.toISOString().slice(0, 10)})`);
  }
  if (result.skipped.length > 0) {
    console.warn(`  Skipped (kept previous/fallback rate): ${result.skipped.join(", ")}`);
  }

  console.log("Effective rate table now:", await getLatestRateTable());
}

main().catch((error) => {
  if (error instanceof StaleDataError) {
    console.error("=== STALE-DATA CIRCUIT BREAKER TRIPPED (AGENTS.md §3y) ===");
    console.error(error.message);
    console.error("The Liquidity Runway engine is now computing against data this old — investigate the Frankfurter outage.");
  } else {
    console.error(error);
  }
  process.exit(1);
});
