/**
 * Manual/cron entry point for the daily crypto-asset price sync
 * (src/server/crypto/price-sync.ts, AGENTS.md §3w).
 *
 * Run with: npm run sync:crypto-prices
 *
 * Needs `--conditions=react-server` like every other standalone script
 * that reaches into src/server/** — see AGENTS.md's deviations list.
 */
import "dotenv/config";
import { syncCryptoPrices } from "../src/server/crypto/price-sync";
import { getLatestCryptoRate } from "../src/server/dal/crypto-prices";

async function main() {
  const result = await syncCryptoPrices();

  if (!result.ok) {
    // A failed sync is not fatal: every consumer falls back to the last
    // stored rate, or FALLBACK_CRYPTO_RATES. Report it and exit non-zero
    // so a scheduler can alert, but never leave the app in a broken state.
    console.error(`Crypto price sync FAILED (${result.source}): ${result.error}`);
    console.error("Consumers will continue using the last stored rate, or the built-in fallback.");
    process.exitCode = 1;
    return;
  }

  console.log(`Crypto price sync OK — source: ${result.source}`);
  for (const rate of result.synced) {
    console.log(`  1 ${rate.symbol} = ${rate.rate.toFixed(2)} ILS  (as of ${rate.asOfDate.toISOString().slice(0, 10)})`);
  }
  if (result.skipped.length > 0) {
    console.warn(`  Skipped (kept previous/fallback rate): ${result.skipped.join(", ")}`);
  }

  console.log("Effective ETH rate now:", await getLatestCryptoRate("ETH"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
