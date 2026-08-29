import "server-only";
import { prisma } from "../db/client";
import {
  BASE_CURRENCY,
  SUPPORTED_CURRENCIES,
  isSupportedCurrency,
  type CurrencyCode,
} from "../../lib/currency";
import { FALLBACK_RATES, IDENTITY_RATE } from "../../lib/exchange-rate";

/**
 * The one DAL module that deliberately does NOT go through
 * `withUserScope` and takes no `userId`.
 *
 * `ExchangeRate` holds public market data belonging to no user and has no
 * RLS policy (see its schema.prisma model comment) — routing it through
 * `withUserScope` would set an `app.current_user_id` that no policy on
 * this table reads, i.e. pure ceremony implying a scoping guarantee that
 * isn't what actually protects this table. What protects it is that it
 * contains nothing user-specific in the first place.
 *
 * `tests/guards/dal-boundary.test.ts` still applies: route handlers and
 * Server Components reach these rows through this module, never through
 * Prisma directly.
 */

export type RateTable = Readonly<Record<CurrencyCode, number>>;

/** ILS itself is never stored or looked up — its rate against itself is exactly 1. */
export const FALLBACK_RATE_TABLE: RateTable = {
  ILS: IDENTITY_RATE,
  USD: FALLBACK_RATES.USD,
  EUR: FALLBACK_RATES.EUR,
  GBP: FALLBACK_RATES.GBP,
};

/**
 * The most recent stored rate for every supported currency, as a plain
 * lookup table. Any currency with no stored row yet falls back to
 * `FALLBACK_RATE_TABLE` rather than throwing — a missing rate must
 * degrade to a slightly-stale conversion, never to a 500 on the
 * dashboard, since every screen showing a foreign-currency figure
 * depends on this.
 */
export async function getLatestRateTable(asOf: Date = new Date()): Promise<RateTable> {
  const rows = await prisma.exchangeRate.findMany({
    where: { asOfDate: { lte: asOf } },
    orderBy: { asOfDate: "desc" },
  });

  const table: Record<CurrencyCode, number> = { ...FALLBACK_RATE_TABLE };
  const seen = new Set<CurrencyCode>();

  for (const row of rows) {
    // Rows are newest-first, so the first row seen per currency is the
    // latest one — later (older) rows for the same currency are skipped.
    if (!isSupportedCurrency(row.currency) || seen.has(row.currency)) continue;
    if (row.currency === BASE_CURRENCY) continue;
    table[row.currency] = Number(row.rate);
    seen.add(row.currency);
  }

  return table;
}

/** The stored rate history for one currency, oldest first — backs a rate-trend view. */
export async function listRateHistory(currency: CurrencyCode, days: number) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return prisma.exchangeRate.findMany({
    where: { currency, asOfDate: { gte: since } },
    orderBy: { asOfDate: "asc" },
  });
}

export type UpsertRateInput = {
  currency: CurrencyCode;
  rate: number;
  asOfDate: Date;
  source: string;
};

/**
 * Idempotent per (currency, asOfDate) — re-running the sync for a day
 * that was already fetched overwrites that day's row rather than
 * appending a duplicate, backed by the `@@unique([currency, asOfDate])`
 * constraint. ILS is rejected outright: storing a row asserting "1 ILS =
 * 1 ILS" would create a second, silently-divergable source of truth for
 * a constant.
 */
export async function upsertRate(input: UpsertRateInput) {
  if (input.currency === BASE_CURRENCY) {
    throw new RangeError(`Refusing to store an exchange rate for the base currency (${BASE_CURRENCY})`);
  }
  if (!Number.isFinite(input.rate) || input.rate <= 0) {
    throw new RangeError(`Exchange rate for ${input.currency} must be positive and finite, received ${input.rate}`);
  }

  return prisma.exchangeRate.upsert({
    where: { currency_asOfDate: { currency: input.currency, asOfDate: input.asOfDate } },
    create: {
      currency: input.currency,
      rate: input.rate.toString(),
      asOfDate: input.asOfDate,
      source: input.source,
    },
    update: { rate: input.rate.toString(), source: input.source },
  });
}

/** Every non-base currency the sync service is expected to fetch. */
export function currenciesToSync(): CurrencyCode[] {
  return SUPPORTED_CURRENCIES.filter((c) => c !== BASE_CURRENCY);
}
