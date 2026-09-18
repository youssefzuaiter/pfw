import "server-only";
import { prisma } from "../db/client";

/**
 * The DAL module for `EquityQuote` (AGENTS.md §3xx) — the last real
 * market price this app observed for an equity symbol the mock feed
 * can't price (a ticker the paper trader booked from a real fill).
 * Mirrors `crypto-prices.ts`/`exchange-rates.ts`: public market data
 * belonging to no user, so no `withUserScope`, no `userId`, no RLS.
 */

export type LatestEquityQuote = {
  symbol: string;
  /** USD per share. */
  priceUsd: number;
  /** When the feed observed the trade behind this price. */
  observedAt: Date;
};

let lastReadFailureLoggedAt = 0;

/**
 * The newest stored quote for each of `symbols`, keyed by symbol. Symbols
 * with no row are simply absent. Never throws: a holding's price has a
 * fallback chain behind it (`src/lib/holding-price.ts` — last fill, then
 * cost), and a read failure here — a deployment whose migration hasn't
 * been applied yet is the concrete case — must degrade to "no quote",
 * never take `computeLiveNetWorth` and every screen above it down, which
 * is precisely the failure this table exists to end. Logged once a
 * minute rather than on every request, same discipline `rate-limit.ts`'s
 * fail-open path uses.
 */
export async function getLatestEquityQuotes(symbols: readonly string[]): Promise<Map<string, LatestEquityQuote>> {
  const wanted = [...new Set(symbols.map((s) => s.toUpperCase()))];
  if (wanted.length === 0) return new Map();
  try {
    // `distinct` + `orderBy observedAt desc` = the newest row per symbol.
    const rows = await prisma.equityQuote.findMany({
      where: { symbol: { in: wanted } },
      orderBy: { observedAt: "desc" },
      distinct: ["symbol"],
      select: { symbol: true, priceUsd: true, observedAt: true },
    });
    return new Map(rows.map((row) => [row.symbol, { symbol: row.symbol, priceUsd: Number(row.priceUsd), observedAt: row.observedAt }]));
  } catch (error) {
    const now = Date.now();
    if (now - lastReadFailureLoggedAt > 60_000) {
      lastReadFailureLoggedAt = now;
      console.error("getLatestEquityQuotes: read failed — valuing holdings without quotes", error);
    }
    return new Map();
  }
}

/** `fetchedAt` of the newest stored row for `symbol`, or `null` if nothing was ever synced — see `crypto-prices.ts`'s `getLatestCryptoRateFetchedAt` for why `fetchedAt`, not `asOfDate`. */
export async function getLatestEquityQuoteFetchedAt(symbol: string): Promise<Date | null> {
  const row = await prisma.equityQuote.findFirst({
    where: { symbol: symbol.toUpperCase() },
    orderBy: { observedAt: "desc" },
    select: { fetchedAt: true },
  });
  return row?.fetchedAt ?? null;
}

export type UpsertEquityQuoteInput = {
  symbol: string;
  priceUsd: number;
  observedAt: Date;
  asOfDate: Date;
  source: string;
};

/**
 * Idempotent per (symbol, asOfDate) — a same-day re-sync overwrites that
 * day's row. `fetchedAt` is set explicitly on both branches for the
 * reason `upsertCryptoRate` documents (`@default(now())` applies only
 * at row creation).
 */
export async function upsertEquityQuote(input: UpsertEquityQuoteInput) {
  if (!Number.isFinite(input.priceUsd) || input.priceUsd <= 0) {
    throw new RangeError(`Equity quote for ${input.symbol} must be positive and finite, received ${input.priceUsd}`);
  }
  const symbol = input.symbol.toUpperCase();
  const fetchedAt = new Date();
  return prisma.equityQuote.upsert({
    where: { symbol_asOfDate: { symbol, asOfDate: input.asOfDate } },
    create: { symbol, priceUsd: input.priceUsd, observedAt: input.observedAt, asOfDate: input.asOfDate, source: input.source, fetchedAt },
    update: { priceUsd: input.priceUsd, observedAt: input.observedAt, source: input.source, fetchedAt },
  });
}
