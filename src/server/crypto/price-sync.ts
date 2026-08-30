import "server-only";
import { z } from "zod";
import { getLatestCryptoRateFetchedAt, upsertCryptoRate } from "../dal/crypto-prices";
import { STALE_DATA_THRESHOLD_HOURS, StaleDataError } from "../stale-data-error";

/**
 * Daily crypto-asset price sync against CoinGecko's free public API
 * (AGENTS.md §3w) — deliberately mirrors `src/server/currency/rate-sync.ts`'s
 * structure closely (fetch/parse separated from persist, never throws
 * from the top-level sync function, Zod-validates the untrusted
 * response). Chosen for the same "no API key" reasoning
 * `rate-sync.ts`'s own header gives for picking Frankfurter over a
 * keyed FX provider — CoinGecko's `/simple/price` endpoint needs no
 * credential for this app's request volume (one symbol, once a day).
 *
 * Only ETH is synced today — the one asset this module's wallet-tracking
 * half (`evm-rpc-client.ts`) actually prices. Adding a second tracked
 * symbol later only means adding it to `SYMBOLS_TO_SYNC` and to
 * CoinGecko's `ids` query param mapping below.
 */

const COINGECKO_BASE_URL = "https://api.coingecko.com/api/v3";

/** Maps this app's own symbol ("ETH") to CoinGecko's `id` ("ethereum") — the two naming schemes aren't the same, and CoinGecko's ids are lowercase full names, not ticker symbols. */
const COINGECKO_ID_BY_SYMBOL: Readonly<Record<string, string>> = {
  ETH: "ethereum",
};

export function symbolsToSync(): string[] {
  return Object.keys(COINGECKO_ID_BY_SYMBOL);
}

const CoinGeckoResponseSchema = z.record(z.string(), z.record(z.string(), z.number()));

export type SyncedCryptoRate = { symbol: string; rate: number; asOfDate: Date };

/** Today's calendar day at UTC midnight — CoinGecko's `/simple/price` has no "as of" concept at all (it's always "right now"), so this sync always writes today's date, same as a fiat sync would for an intraday-refreshed rate. */
function todayUtcMidnight(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Fetches today's rates without touching the database — separated from
 * the persisting step so the network/parsing half is testable with a
 * stubbed `fetch` and no Postgres, same split `rate-sync.ts`'s
 * `fetchLatestRates` already establishes.
 */
export async function fetchLatestCryptoRates(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<SyncedCryptoRate[]> {
  const symbols = symbolsToSync();
  const ids = symbols.map((s) => COINGECKO_ID_BY_SYMBOL[s]).join(",");
  const url = `${COINGECKO_BASE_URL}/simple/price?ids=${ids}&vs_currencies=ils`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Crypto price provider returned HTTP ${response.status}`);
  }

  const parsed = CoinGeckoResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(`Crypto price provider returned an unexpected payload: ${parsed.error.message}`);
  }

  const asOfDate = todayUtcMidnight();
  const rates: SyncedCryptoRate[] = [];

  for (const symbol of symbols) {
    const coinGeckoId = COINGECKO_ID_BY_SYMBOL[symbol];
    const quote = parsed.data[coinGeckoId]?.ils;
    // Discard anything malformed rather than store a garbage rate — a
    // hostile or broken response can only cause this ONE symbol's sync
    // to be skipped, never write a wrong price (same reasoning
    // rate-sync.ts already gives for its own currency loop).
    if (typeof quote !== "number" || !Number.isFinite(quote) || quote <= 0) continue;
    rates.push({ symbol, rate: quote, asOfDate });
  }

  return rates;
}

export type CryptoPriceSyncResult = {
  ok: boolean;
  source: string;
  synced: SyncedCryptoRate[];
  skipped: string[];
  error?: string;
};

/**
 * Fetches and persists today's crypto rates. Ordinarily never throws — a
 * provider outage must not take down whatever triggered the sync, and
 * every consumer already degrades to the last stored rate (or
 * `FALLBACK_CRYPTO_RATES`) on its own, same resilience contract
 * `rate-sync.ts`'s `syncExchangeRates` already has — UNLESS the fetch
 * failure lines up with an already-stale stored rate (see
 * `StaleDataError`'s own doc comment for exactly why that combination,
 * and only that combination, is the one case worth failing loudly for):
 * then this throws `StaleDataError` instead of returning `{ ok: false }`,
 * so the sync SCRIPT (`scripts/sync-crypto-prices.ts`) exits non-zero
 * rather than silently repeating the same "nothing happened" no-event
 * indefinitely while the Liquidity Runway engine keeps computing against
 * an increasingly outdated ETH price.
 */
export async function syncCryptoPrices(fetchImpl: typeof fetch = fetch): Promise<CryptoPriceSyncResult> {
  const source = "coingecko.com";
  const wanted = symbolsToSync();

  try {
    const rates = await fetchLatestCryptoRates(fetchImpl);

    for (const rate of rates) {
      await upsertCryptoRate({ symbol: rate.symbol, rate: rate.rate, asOfDate: rate.asOfDate, source });
    }

    const syncedSymbols = new Set(rates.map((r) => r.symbol));
    return { ok: true, source, synced: rates, skipped: wanted.filter((s) => !syncedSymbols.has(s)) };
  } catch (error) {
    const staleSymbols: { symbol: string; ageHours: number }[] = [];
    for (const symbol of wanted) {
      const latestFetchedAt = await getLatestCryptoRateFetchedAt(symbol);
      if (!latestFetchedAt) continue; // Never synced at all — FALLBACK_CRYPTO_RATES covers this; it's a "no data yet" state, not a "data went stale" one.
      const ageHours = (Date.now() - latestFetchedAt.getTime()) / (60 * 60 * 1000);
      if (ageHours > STALE_DATA_THRESHOLD_HOURS) staleSymbols.push({ symbol, ageHours });
    }

    if (staleSymbols.length > 0) {
      const oldest = Math.max(...staleSymbols.map((s) => s.ageHours));
      throw new StaleDataError(
        `Crypto price sync failed (${error instanceof Error ? error.message : String(error)}) and the stored rate for ` +
          `${staleSymbols.map((s) => s.symbol).join(", ")} is already ${oldest.toFixed(1)}h old (> ${STALE_DATA_THRESHOLD_HOURS}h threshold). ` +
          `Refusing to let the Liquidity Runway engine keep projecting against it silently.`,
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
