/**
 * Nightly ledger reconciliation: compares Alpaca's real, live paper
 * positions against this app's own `PortfolioHolding` rows for the
 * Tier-0 paper-trading agent's user, and logs a structured warning for
 * every quantity mismatch. Alert-only — never writes to the database.
 *
 * Idempotent by construction: this script only ever READS (Alpaca's
 * REST API, then Prisma) and logs — running it any number of times, in
 * any order, produces the identical comparison result each time with no
 * accumulating side effect, unlike a script that upserts or backfills.
 *
 * Run with: npm run audit:paper-trades
 *   (equivalent to: npx tsx --conditions=react-server scripts/reconcile-ledger.ts)
 *
 * Deliberately placed under the repo-root `scripts/` directory, not
 * `src/scripts/` — `tests/guards/admin-client-boundary.test.ts` only
 * walks `src/`, and every existing maintenance script that needs the
 * RLS-bypassing admin client already lives here for that exact reason
 * (AGENTS.md §3ee) — same convention `reset-paper-trades.ts` already
 * follows. `--conditions=react-server` is required because
 * `admin-client.ts` is `server-only`-guarded.
 *
 * DELIBERATELY DOES NOT CALL ALPACA'S REST API DIRECTLY. PFW has never
 * held Alpaca credentials — the whole point of splitting the Tier-0
 * agent into its own FastAPI service (`~/paper-trader`) was to keep
 * broker credentials scoped to exactly one process. Duplicating
 * ALPACA_API_KEY_ID/SECRET into this repo's own `.env` for one audit
 * script would widen that credential's blast radius for no real
 * benefit, since the agent service already has an authenticated broker
 * client sitting right there. This script instead calls that service's
 * own new `GET /positions` endpoint (same "local-only, same-machine
 * service call" pattern the Agent Telemetry dashboard already
 * established for `GET /telemetry`).
 *
 * KNOWN LIMITATION, stated plainly rather than glossed over: some
 * symbols (MSFT, AMZN, GOOGL) are shared between the Tier-0 agent's own
 * market scenarios AND this app's separate, PRE-EXISTING mock "trading
 * desk" feature (AGENTS.md §3l), which trades against a simulated price
 * feed that has never touched Alpaca at all. For those overlapping
 * symbols, `PortfolioHolding.quantity` is a MIX of real Alpaca-bound
 * quantity and purely-mock quantity — comparing the combined figure
 * against Alpaca's real position will report drift that isn't a real
 * sync bug, just two logically distinct trading systems sharing one
 * row. This script does not attempt to separate the two (there is no
 * column recording which quantity came from which source) — every
 * warning for one of these three symbols should be read with that
 * caveat in mind, not treated as automatically actionable the way a
 * TSLA/NVDA/AAPL mismatch would be.
 */
import "dotenv/config";
import { createAdminClient } from "../src/server/db/admin-client";
import { getPaperTradingUserId } from "../src/server/env";

/** Same local-only origin the Agent Telemetry dashboard already uses (src/proxy.ts's connect-src comment) — overridable for a non-default port/host. */
const PAPER_TRADER_SERVICE_URL = process.env.PAPER_TRADER_SERVICE_URL ?? "http://127.0.0.1:8000";

/**
 * Alpaca's own fractional-quantity precision (9 decimal places) is the
 * real upstream constraint — the same tolerance `webhook/trades/route.ts`'s
 * `QUANTITY_PATTERN` already encodes. Below this, a difference is
 * floating-point noise from the Decimal(30,18) <-> JS number round trip,
 * not a real discrepancy.
 */
const QUANTITY_TOLERANCE = 1e-9;

type AlpacaPosition = { symbol: string; qty: string };

type MismatchReport = {
  ticker: string;
  alpacaQty: number;
  pfwQty: number;
  deltaQty: number;
};

async function fetchAlpacaPositions(): Promise<Map<string, number>> {
  const response = await fetch(`${PAPER_TRADER_SERVICE_URL}/positions`);
  if (!response.ok) {
    throw new Error(`GET ${PAPER_TRADER_SERVICE_URL}/positions returned ${response.status}`);
  }
  const positions = (await response.json()) as AlpacaPosition[];
  return new Map(positions.map((p) => [p.symbol.toUpperCase(), Number.parseFloat(p.qty)]));
}

async function main() {
  const userId = getPaperTradingUserId();
  if (!userId) {
    console.error("PAPER_TRADING_USER_ID is not set in .env — nothing to reconcile.");
    process.exitCode = 1;
    return;
  }

  const alpacaPositions = await fetchAlpacaPositions();

  const admin = createAdminClient();
  const holdings = await admin.portfolioHolding.findMany({
    where: { userId },
    select: { symbol: true, quantity: true },
    orderBy: { symbol: "asc" },
  });

  const pfwQuantities = new Map(holdings.map((h) => [h.symbol.toUpperCase(), h.quantity.toNumber()]));

  const allSymbols = new Set([...alpacaPositions.keys(), ...pfwQuantities.keys()]);
  const mismatches: MismatchReport[] = [];

  for (const symbol of allSymbols) {
    const alpacaQty = alpacaPositions.get(symbol) ?? 0;
    const pfwQty = pfwQuantities.get(symbol) ?? 0;
    const deltaQty = alpacaQty - pfwQty;

    if (Math.abs(deltaQty) > QUANTITY_TOLERANCE) {
      mismatches.push({ ticker: symbol, alpacaQty, pfwQty, deltaQty });
    }
  }

  if (mismatches.length === 0) {
    console.log(
      `Reconciliation OK — ${allSymbols.size} symbol(s) checked for user ${userId}, no drift detected.`,
    );
    return;
  }

  for (const mismatch of mismatches) {
    // Structured, not prose — every field named explicitly so this is
    // machine-parseable by whatever eventually wraps this in a cron/alert
    // pipeline, not just readable by a human tailing the log.
    console.warn(
      JSON.stringify({
        level: "warning",
        message: "ledger_drift_detected",
        ticker: mismatch.ticker,
        alpacaQty: mismatch.alpacaQty,
        pfwQty: mismatch.pfwQty,
        deltaQty: mismatch.deltaQty,
      }),
    );
  }

  console.warn(
    `Reconciliation found drift in ${mismatches.length} of ${allSymbols.size} symbol(s) for user ${userId}.`,
  );
  process.exitCode = 1;
}

main().catch((error) => {
  console.error("reconcile-ledger failed:", error);
  process.exitCode = 1;
});
