import "server-only";
import { z } from "zod";
import { BASE_CURRENCY, isSupportedCurrency, type CurrencyCode } from "../../lib/currency";
import { currenciesToSync, getLatestRateFetchedAt, upsertRate, type RateTable } from "../dal/exchange-rates";
import { getLatestRateTable } from "../dal/exchange-rates";
import { STALE_DATA_THRESHOLD_HOURS, StaleDataError } from "../stale-data-error";

/**
 * Daily exchange-rate sync against Frankfurter (https://frankfurter.dev),
 * which republishes the European Central Bank's daily reference rates.
 *
 * Chosen over a keyed provider deliberately: it needs no API key, so it
 * introduces no new secret to provision, rotate, or keep out of the
 * client bundle — consistent with the app's Tier 2 posture, where the
 * only real external credential (ANTHROPIC_API_KEY) earns its keep. The
 * env-var contract for a keyed provider already exists if this is ever
 * swapped (see src/server/env.ts's BANK_API_* scaffolding for the
 * pattern).
 *
 * SECURITY: the response is untrusted input crossing a trust boundary,
 * exactly like a request body — so it is Zod-validated, every rate is
 * re-checked as a positive finite number, and any currency the app
 * doesn't support is discarded rather than stored. A malformed or hostile
 * response can therefore only cause a sync to *fail*, never to write a
 * garbage rate that would silently corrupt every converted figure in the
 * app.
 */

const FRANKFURTER_BASE_URL = "https://api.frankfurter.dev/v1";

/** Frankfurter quotes "how much of X for 1 unit of base" — we request base=ILS
 * and invert, since our own convention is ILS per 1 foreign unit. */
const FrankfurterResponseSchema = z.object({
  base: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected an ISO YYYY-MM-DD date"),
  rates: z.record(z.string(), z.number()),
});

export type SyncedRate = {
  currency: CurrencyCode;
  rate: number;
  asOfDate: Date;
};

export type RateSyncResult = {
  ok: boolean;
  source: string;
  synced: SyncedRate[];
  /** Currencies that were requested but not usably returned — they keep their previous/fallback rate. */
  skipped: CurrencyCode[];
  error?: string;
};

/** Frankfurter's `date` is a plain calendar day; parse it as UTC midnight so it
 * lands on the schema's `@db.Date` column without a timezone shifting it a day. */
function parseAsOfDate(isoDay: string): Date {
  return new Date(`${isoDay}T00:00:00.000Z`);
}

/**
 * Fetches today's rates without touching the database — separated from
 * the persisting step so the network/parsing half is testable with a
 * stubbed `fetch` and no Postgres.
 */
export async function fetchLatestRates(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<{ asOfDate: Date; rates: SyncedRate[] }> {
  const wanted = currenciesToSync();
  const url = `${FRANKFURTER_BASE_URL}/latest?base=${BASE_CURRENCY}&symbols=${wanted.join(",")}`;

  // An unbounded fetch in a background job is a liveness hazard: a
  // provider that accepts the connection and never responds would hang
  // the sync indefinitely.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Exchange rate provider returned HTTP ${response.status}`);
  }

  const parsed = FrankfurterResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(`Exchange rate provider returned an unexpected payload: ${parsed.error.message}`);
  }

  const asOfDate = parseAsOfDate(parsed.data.date);
  const rates: SyncedRate[] = [];

  for (const [currency, quotedPerBase] of Object.entries(parsed.data.rates)) {
    // Discard anything we don't support, the base currency itself, and
    // any non-positive/non-finite quote — an inverted zero would be
    // Infinity, which must never reach the database.
    if (!isSupportedCurrency(currency) || currency === BASE_CURRENCY) continue;
    if (!Number.isFinite(quotedPerBase) || quotedPerBase <= 0) continue;

    // Invert: the provider gives foreign-per-1-ILS, we store ILS-per-1-foreign.
    rates.push({ currency, rate: 1 / quotedPerBase, asOfDate });
  }

  return { asOfDate, rates };
}

/**
 * Fetches and persists today's rates. Ordinarily never throws: a
 * provider outage must not take down whatever triggered the sync, and
 * every consumer already degrades to the last stored rate (or
 * `FALLBACK_RATE_TABLE`) on its own — so a failed sync is usually a
 * logged non-event, not an error path callers have to handle — UNLESS
 * the fetch failure lines up with an already-stale stored rate (see
 * `StaleDataError`'s doc comment): then this throws `StaleDataError`
 * instead, so the sync SCRIPT (`scripts/sync-exchange-rates.ts`) exits
 * non-zero rather than an unattended Frankfurter outage compounding
 * silently while the Liquidity Runway engine keeps converting foreign-
 * currency balances at an increasingly outdated rate.
 */
export async function syncExchangeRates(fetchImpl: typeof fetch = fetch): Promise<RateSyncResult> {
  const source = "frankfurter.dev (ECB)";
  const wanted = currenciesToSync();

  try {
    const { rates } = await fetchLatestRates(fetchImpl);

    const synced: SyncedRate[] = [];
    for (const rate of rates) {
      await upsertRate({ currency: rate.currency, rate: rate.rate, asOfDate: rate.asOfDate, source });
      synced.push(rate);
    }

    const syncedCurrencies = new Set(synced.map((r) => r.currency));
    return {
      ok: true,
      source,
      synced,
      skipped: wanted.filter((c) => !syncedCurrencies.has(c)),
    };
  } catch (error) {
    const staleCurrencies: { currency: CurrencyCode; ageHours: number }[] = [];
    for (const currency of wanted) {
      const latestFetchedAt = await getLatestRateFetchedAt(currency);
      if (!latestFetchedAt) continue; // Never synced at all — FALLBACK_RATE_TABLE covers this; it's a "no data yet" state, not a "data went stale" one.
      const ageHours = (Date.now() - latestFetchedAt.getTime()) / (60 * 60 * 1000);
      if (ageHours > STALE_DATA_THRESHOLD_HOURS) staleCurrencies.push({ currency, ageHours });
    }

    if (staleCurrencies.length > 0) {
      const oldest = Math.max(...staleCurrencies.map((c) => c.ageHours));
      throw new StaleDataError(
        `Exchange rate sync failed (${error instanceof Error ? error.message : String(error)}) and the stored rate for ` +
          `${staleCurrencies.map((c) => c.currency).join(", ")} is already ${oldest.toFixed(1)}h old (> ${STALE_DATA_THRESHOLD_HOURS}h threshold). ` +
          `Refusing to let the Liquidity Runway engine keep converting against it silently.`,
      );
    }

    return {
      ok: false,
      source,
      synced: [],
      skipped: wanted,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The read path every screen uses: today's rate table, syncing first only
 * if nothing has been stored yet for a currency. Callers get a usable
 * table unconditionally.
 */
export async function getRateTable(): Promise<RateTable> {
  return getLatestRateTable();
}
