import "server-only";
import { prisma } from "../db/client";

/**
 * The DAL module for `CryptoAssetPrice` (AGENTS.md §3w) — deliberately
 * mirrors `exchange-rates.ts` in every structural respect (see
 * `CryptoAssetPrice`'s own schema.prisma comment for why they aren't the
 * same model). Same "no `withUserScope`, no `userId`" shape as
 * `exchange-rates.ts`: this is public market data belonging to no user,
 * with no RLS policy to route through.
 */

/** Fallback ETH/ILS rate for when no live sync has ever run yet — same "a fresh install or a sync outage degrades, never breaks" role `exchange-rate.ts`'s `FALLBACK_RATES` plays for fiat. Approximate on purpose (crypto prices move far more than FX rates do) — this is a last-resort floor, not a claim of current accuracy. */
export const FALLBACK_CRYPTO_RATES: Readonly<Record<string, number>> = {
  ETH: 12_000,
};

/**
 * The most recent stored ILS-per-1-whole-unit rate for `symbol`, falling
 * back to `FALLBACK_CRYPTO_RATES` (never throwing) when nothing has been
 * synced yet — same "a missing rate must degrade a conversion, never a
 * 500" reasoning `getLatestRateTable` already establishes for fiat.
 */
export async function getLatestCryptoRate(symbol: string, asOf: Date = new Date()): Promise<number> {
  const row = await prisma.cryptoAssetPrice.findFirst({
    where: { symbol, asOfDate: { lte: asOf } },
    orderBy: { asOfDate: "desc" },
  });
  if (row) return Number(row.rate);
  return FALLBACK_CRYPTO_RATES[symbol] ?? 0;
}

/**
 * The `fetchedAt` timestamp (NOT `asOfDate`, deliberately — see below) of
 * the single most recent stored row for `symbol`, or `null` if nothing
 * has ever been synced — the staleness check `price-sync.ts`'s circuit
 * breaker (AGENTS.md §3y) needs, kept separate from `getLatestCryptoRate`
 * since that function's fallback-to-`FALLBACK_CRYPTO_RATES` behavior
 * deliberately hides whether a real row exists at all.
 *
 * `asOfDate` is a `@db.Date` calendar-day marker with no time component
 * — a row synced at 23:59 and one synced at 00:01 the same day both
 * carry the identical `asOfDate`, so measuring "how many hours old" a
 * rate is FROM `asOfDate` would overstate its age by up to nearly 24h
 * depending purely on what time of day the check happens to run, not on
 * how long ago the sync actually occurred. `fetchedAt` is a real
 * `DateTime @default(now())` written at insert time — the only field
 * that actually answers "how long ago did we last hear from the
 * provider."
 */
export async function getLatestCryptoRateFetchedAt(symbol: string): Promise<Date | null> {
  const row = await prisma.cryptoAssetPrice.findFirst({
    where: { symbol },
    orderBy: { asOfDate: "desc" },
    select: { fetchedAt: true },
  });
  return row?.fetchedAt ?? null;
}

export type UpsertCryptoRateInput = {
  symbol: string;
  rate: number;
  asOfDate: Date;
  source: string;
};

/**
 * Idempotent per (symbol, asOfDate) — mirrors `upsertRate`'s exact
 * reasoning (exchange-rates.ts). `fetchedAt` is set explicitly on BOTH
 * branches, not left to its `@default(now())` — that default only ever
 * applies at row CREATION, so a same-day re-sync (the `update` branch,
 * e.g. a cron re-run) would otherwise leave `fetchedAt` stuck at
 * whenever the row was first written that day, silently defeating
 * `getLatestCryptoRateFetchedAt`'s whole "how long ago did we last
 * actually hear from the provider" purpose.
 */
export async function upsertCryptoRate(input: UpsertCryptoRateInput) {
  if (!Number.isFinite(input.rate) || input.rate <= 0) {
    throw new RangeError(`Crypto rate for ${input.symbol} must be positive and finite, received ${input.rate}`);
  }

  const fetchedAt = new Date();
  return prisma.cryptoAssetPrice.upsert({
    where: { symbol_asOfDate: { symbol: input.symbol, asOfDate: input.asOfDate } },
    create: { symbol: input.symbol, rate: input.rate.toString(), asOfDate: input.asOfDate, source: input.source, fetchedAt },
    update: { rate: input.rate.toString(), source: input.source, fetchedAt },
  });
}
