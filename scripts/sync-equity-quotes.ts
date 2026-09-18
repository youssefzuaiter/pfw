/**
 * Manual/cron entry point for the equity-quote sync
 * (src/server/market-data/quote-sync.ts, AGENTS.md §3xx) — the latest
 * Alpaca IEX price, via the paper trader's signed /control/quotes, for
 * every ticker anyone holds that the mock feed can't price.
 *
 * Run with: npm run sync:quotes
 *
 * Needs the trader reachable at PAPER_TRADER_SERVICE_URL and the shared
 * WEBHOOK_SECRET, and `--conditions=react-server` like every other
 * standalone script that reaches into src/server/** (AGENTS.md's
 * deviations list).
 */
import "dotenv/config";
import { syncEquityQuotes } from "../src/server/market-data/quote-sync";
import { getLatestEquityQuotes } from "../src/server/dal/equity-quotes";

async function main() {
  const result = await syncEquityQuotes();

  if (!result.ok) {
    // Not fatal: every holding keeps its previous quote, or its last fill,
    // or its cost basis (src/lib/holding-price.ts). Report and exit
    // non-zero so a scheduler can alert.
    console.error(`Equity quote sync FAILED (${result.source}): ${result.error}`);
    console.error("Holdings will keep their previous quote / last fill.");
    process.exitCode = 1;
    return;
  }

  console.log(`Equity quote sync OK — source: ${result.source}`);
  if (result.synced.length === 0 && result.skipped.length === 0) {
    console.log("  Nothing to do: no open position outside the mock universe.");
    return;
  }
  const quotes = await getLatestEquityQuotes(result.synced);
  for (const symbol of result.synced) {
    const quote = quotes.get(symbol);
    console.log(`  ${symbol.padEnd(6)} $${quote?.priceUsd.toFixed(2) ?? "?"}  observed ${quote?.observedAt.toISOString() ?? "?"}`);
  }
  if (result.skipped.length > 0) {
    console.warn(`  Skipped (no quote returned, kept previous): ${result.skipped.join(", ")}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
