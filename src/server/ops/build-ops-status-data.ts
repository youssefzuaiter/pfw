import "server-only";
import { cache } from "react";
import type { CurrencyCode } from "../../lib/currency";
import { getEncryptionKeyFingerprints } from "../crypto/field-encryption";
import { getMostRecentCryptoPriceFetchedAt } from "../dal/crypto-prices";
import { getMostRecentEquityQuoteFetchedAt } from "../dal/equity-quotes";
import { currenciesToSync, getLatestRateFetchedAt } from "../dal/exchange-rates";
import { getDeploymentInfo, getOperatorAlertEmail } from "../env";

/**
 * Everything `/settings/ops` renders: which build is live, where the
 * encryption-key rotation stands, and how recently each scheduled sync
 * actually heard from its provider.
 *
 * Exists because until now this app could not answer any of those
 * questions about itself — they took the Vercel dashboard (which
 * paywalls a log window wider than 30 minutes on the Hobby plan) or a
 * `curl` to `/api/cron` with the cron secret in hand. That friction is
 * real: §3zz's production key rotation ran a whole pass blind because
 * the commit hadn't actually been pushed and nothing in the app said so.
 *
 * `cache()`-wrapped for the same request-scoping reason every other
 * `build-*-data.ts` aggregator is (AGENTS.md §3c) — React's per-request
 * cache, never Next's cross-request `'use cache'`.
 */

/** Hours since a sync's last successful contact with its provider, bucketed. */
export type FreshnessTier = "fresh" | "warning" | "critical" | "never" | "not_applicable";

/** Under 36h means the nightly 00:00 UTC cron ran at least once since the last one was due (24h + a 12h grace for a late or slow run). */
const FRESH_MAX_HOURS = 36;
/** Under 72h means at most two consecutive nightly runs were missed — worth noticing, not yet worth alarm. */
const WARNING_MAX_HOURS = 72;

export type SyncStatus = {
  /** What this row is: a currency code for FX, or the sync's own name. */
  label: string;
  fetchedAt: Date | null;
  ageHours: number | null;
  tier: FreshnessTier;
};

export type OpsStatusData = {
  deployment: { commitSha: string | null; environment: string | null; url: string | null };
  encryptionKey: { currentKeyId: string; nextKeyId: string | null; rotationInProgress: boolean };
  /** One row per currency the FX sync covers — a single skipped currency must not hide behind a fresh one. */
  exchangeRates: SyncStatus[];
  cryptoPrices: SyncStatus;
  equityQuotes: SyncStatus;
  /** Whether an operator alert address is configured — never the address itself. */
  operatorAlertConfigured: boolean;
  generatedAt: Date;
};

export function classifyFreshness(fetchedAt: Date | null, now: Date): { ageHours: number | null; tier: FreshnessTier } {
  if (!fetchedAt) return { ageHours: null, tier: "never" };
  const ageHours = (now.getTime() - fetchedAt.getTime()) / (60 * 60 * 1000);
  if (ageHours < FRESH_MAX_HOURS) return { ageHours, tier: "fresh" };
  if (ageHours < WARNING_MAX_HOURS) return { ageHours, tier: "warning" };
  return { ageHours, tier: "critical" };
}

function toSyncStatus(label: string, fetchedAt: Date | null, now: Date): SyncStatus {
  return { label, fetchedAt, ...classifyFreshness(fetchedAt, now) };
}

/**
 * `cache()` with no arguments on purpose: unlike
 * `build-monte-carlo-data.ts`, this has no varying inputs to key on, so
 * reading the clock INSIDE is what lets every call in one request share
 * one result. Passing the time in would do the opposite — two calls a
 * millisecond apart would miss the cache and re-query.
 */
export const buildOpsStatusData = cache(async (): Promise<OpsStatusData> => {
  const now = new Date();
  const currencies = currenciesToSync();

  const [rateFetchedAts, cryptoFetchedAt, equityFetchedAt] = await Promise.all([
    Promise.all(currencies.map((currency: CurrencyCode) => getLatestRateFetchedAt(currency))),
    getMostRecentCryptoPriceFetchedAt(),
    getMostRecentEquityQuoteFetchedAt(),
  ]);

  const keys = getEncryptionKeyFingerprints();

  const equity = toSyncStatus("Equity quotes", equityFetchedAt, now);

  return {
    deployment: getDeploymentInfo(),
    encryptionKey: {
      currentKeyId: keys.current,
      nextKeyId: keys.next,
      // ENCRYPTION_KEY_NEXT being set IS the rotation, by definition —
      // every new write goes to it from that moment (§3zz).
      rotationInProgress: keys.next !== null,
    },
    exchangeRates: currencies.map((currency: CurrencyCode, index: number) =>
      toSyncStatus(currency, rateFetchedAts[index], now),
    ),
    cryptoPrices: toSyncStatus("Crypto prices", cryptoFetchedAt, now),
    // No quote ever synced is the normal state for an account with no
    // trader-booked tickers outside the mock universe — reporting that as
    // "never synced" alongside two genuinely-stale rows would train the
    // reader to ignore the whole panel.
    equityQuotes: equity.tier === "never" ? { ...equity, tier: "not_applicable" } : equity,
    operatorAlertConfigured: getOperatorAlertEmail() !== null,
    generatedAt: now,
  };
});
