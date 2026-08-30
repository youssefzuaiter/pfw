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

export type UpsertCryptoRateInput = {
  symbol: string;
  rate: number;
  asOfDate: Date;
  source: string;
};

/** Idempotent per (symbol, asOfDate) — mirrors `upsertRate`'s exact reasoning (exchange-rates.ts). */
export async function upsertCryptoRate(input: UpsertCryptoRateInput) {
  if (!Number.isFinite(input.rate) || input.rate <= 0) {
    throw new RangeError(`Crypto rate for ${input.symbol} must be positive and finite, received ${input.rate}`);
  }

  return prisma.cryptoAssetPrice.upsert({
    where: { symbol_asOfDate: { symbol: input.symbol, asOfDate: input.asOfDate } },
    create: { symbol: input.symbol, rate: input.rate.toString(), asOfDate: input.asOfDate, source: input.source },
    update: { rate: input.rate.toString(), source: input.source },
  });
}
