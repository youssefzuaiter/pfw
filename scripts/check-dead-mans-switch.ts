/**
 * Manual/cron entry point for the Dead Man's Switch Activity Monitor's
 * batch half (src/server/dead-mans-switch/inactivity-check.ts,
 * AGENTS.md §3t) — advances ACTIVE -> GRACE_PERIOD -> TRIGGERED for
 * every user whose inactivity/grace thresholds have elapsed.
 *
 * Run with: npm run check:dead-mans-switch
 *
 * Needs `--conditions=react-server` like every other standalone script
 * that reaches into src/server/** — see AGENTS.md's deviations list.
 * Actually scheduling this to run periodically (a real OS/platform cron)
 * is a deployment step, not built here — same documented gap
 * scripts/sync-exchange-rates.ts already has.
 */
import "dotenv/config";
import { runInactivityCheck } from "../src/server/dead-mans-switch/inactivity-check";

async function main() {
  const result = await runInactivityCheck();

  if (result.movedToGracePeriod.length === 0 && result.triggered.length === 0) {
    console.log("Dead Man's Switch check: no transitions (all switches active or already in a later stage).");
    return;
  }

  if (result.movedToGracePeriod.length > 0) {
    console.log(`Moved to GRACE_PERIOD: ${result.movedToGracePeriod.join(", ")}`);
  }
  if (result.triggered.length > 0) {
    console.warn(`TRIGGERED (recovery portal now open for beneficiaries): ${result.triggered.join(", ")}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
