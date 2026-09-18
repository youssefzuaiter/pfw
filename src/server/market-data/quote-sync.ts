import "server-only";
import { isKnownMockSymbol } from "../../lib/mock-market-data";
import { createAdminClient } from "../db/admin-client";
import { upsertEquityQuote } from "../dal/equity-quotes";
import { fetchPaperTraderQuotes } from "../paper-trader/quotes-client";

/**
 * Daily equity-quote sync for every symbol anyone holds that the mock
 * feed can't price (AGENTS.md §3xx) — the tickers the paper trader books
 * from real Alpaca fills. Same shape as `price-sync.ts`/`rate-sync.ts`:
 * fetch/parse separated from persist, never throws from the top-level
 * function, an outage is a logged `{ ok: false }` and every consumer
 * keeps degrading on its own (`src/lib/holding-price.ts` falls back to
 * the last stored quote, then the last fill, then cost).
 *
 * No stale-data circuit breaker here, unlike the FX/crypto syncs: those
 * feed the Liquidity Runway engine silently, whereas a stale quote is
 * SHOWN as one — the resolver carries `observedAt` and `/trading`,
 * `/trading/portfolio` label a quote older than a day with its date.
 *
 * Symbol discovery is the one cross-user read in this module — "which
 * tickers does ANY user hold outside the mock universe" — a scheduled
 * batch job with no session and therefore no single `userId` to scope a
 * `withUserScope` transaction by, exactly the shape
 * `dead-mans-switch/inactivity-check.ts` already has. Hence the admin
 * client, allowlisted in `tests/guards/admin-client-boundary.test.ts`,
 * used for that one `SELECT DISTINCT symbol` and nothing else: the
 * write path goes through the ordinary DAL (`EquityQuote` has no RLS to
 * bypass in the first place).
 */
export type EquityQuoteSyncResult = {
  ok: boolean;
  source: string;
  /** Symbols a quote was stored for. */
  synced: string[];
  /** Symbols wanted but not answered — kept at their previous quote/fill. */
  skipped: string[];
  error?: string;
};

export const EQUITY_QUOTE_SOURCE = "alpaca-iex via paper-trader";

/** Today's calendar day at UTC midnight — one row per symbol per day, same convention as the FX/crypto syncs. */
function todayUtcMidnight(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Every distinct symbol with an open position, across all users, that the mock feed does not cover. */
export async function listHeldSymbolsOutsideMockUniverse(): Promise<string[]> {
  const admin = createAdminClient();
  try {
    const rows = await admin.portfolioHolding.findMany({
      where: { quantity: { gt: 0 } },
      distinct: ["symbol"],
      select: { symbol: true },
      orderBy: { symbol: "asc" },
    });
    return rows.map((row) => row.symbol.toUpperCase()).filter((symbol) => !isKnownMockSymbol(symbol));
  } finally {
    await admin.$disconnect();
  }
}

export async function syncEquityQuotes(fetchImpl: typeof fetch = fetch): Promise<EquityQuoteSyncResult> {
  const source = EQUITY_QUOTE_SOURCE;
  let wanted: string[] = [];
  try {
    wanted = await listHeldSymbolsOutsideMockUniverse();
    if (wanted.length === 0) return { ok: true, source, synced: [], skipped: [] };

    const result = await fetchPaperTraderQuotes(wanted, fetchImpl);
    const asOfDate = todayUtcMidnight();
    for (const quote of result.quotes) {
      await upsertEquityQuote({ symbol: quote.symbol, priceUsd: quote.priceUsd, observedAt: quote.observedAt, asOfDate, source });
    }
    return { ok: true, source, synced: result.quotes.map((q) => q.symbol), skipped: result.missing };
  } catch (error) {
    return {
      ok: false,
      source,
      synced: [],
      skipped: wanted,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
