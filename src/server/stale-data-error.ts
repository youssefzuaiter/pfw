import "server-only";

/**
 * Thrown by a rate-sync module (AGENTS.md §3y) when BOTH of two things
 * are true at once: the live provider fetch just failed, AND the
 * existing stored rate it would otherwise silently keep serving is
 * already more than `STALE_DATA_THRESHOLD_HOURS` old. Neither condition
 * alone is exceptional — a fetch failing 10 minutes after the last
 * successful sync is a total non-event (the stored rate is still fresh);
 * a rate simply being >24h old while syncs keep succeeding daily is
 * also fine (this app's rates are refreshed once a day, not
 * continuously). It's the COMBINATION — no fresh data arriving AND the
 * data on hand already old enough to plausibly be wrong — that means the
 * Liquidity Runway engine (`src/lib/liquidity-runway.ts`, §3v) would
 * otherwise silently project a burn-rate/runway figure against a price
 * that could be substantially stale (a crypto price especially can move
 * far more in 24+ hours than an FX rate does), which is a materially
 * worse outcome than the sync just visibly failing.
 *
 * Deliberately thrown from the SYNC function
 * (`syncCryptoPrices`/`syncExchangeRates`), not from the read path
 * (`getLatestCryptoRate`/`getLatestRateTable`) — those reads stay exactly
 * as forgiving as they've always been (see their own doc comments:
 * "a missing/stale rate must degrade a conversion, never a 500", still
 * true and still the right behavior for an ordinary page render). This
 * error is for the SYNC PROCESS itself (`scripts/sync-crypto-prices.ts`,
 * `scripts/sync-exchange-rates.ts`) to fail loudly — a non-zero exit a
 * cron/alerting setup can actually notice — instead of returning its
 * usual `{ ok: false }` and letting an unattended outage compound
 * silently, day after day, with nothing ever surfacing it.
 */
export const STALE_DATA_THRESHOLD_HOURS = 24;

export class StaleDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleDataError";
  }
}
