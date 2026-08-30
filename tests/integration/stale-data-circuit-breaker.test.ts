import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/server/db/client";
import { syncCryptoPrices, symbolsToSync } from "../../src/server/crypto/price-sync";
import { syncExchangeRates } from "../../src/server/currency/rate-sync";
import { currenciesToSync } from "../../src/server/dal/exchange-rates";
import type { CurrencyCode } from "../../src/lib/currency";
import { StaleDataError } from "../../src/server/stale-data-error";

/**
 * Integration coverage for the stale-data circuit breaker (AGENTS.md
 * §3y): both `syncCryptoPrices` (CoinGecko) and `syncExchangeRates`
 * (Frankfurter) should throw `StaleDataError` — instead of their
 * ordinary silent `{ ok: false }` degradation — specifically when a
 * fetch failure coincides with an ALREADY-stale stored rate for at
 * least one of the symbols/currencies they sync.
 *
 * Both sync functions operate on a fixed, non-injectable symbol/currency
 * list (`symbolsToSync()` is hardcoded to `["ETH"]`;
 * `currenciesToSync()` to every supported non-base currency) — there's
 * no way to point either at a disposable test-only symbol, so these
 * tests operate on the REAL latest rows for every symbol/currency they
 * cover, which may be real data from an earlier live sync elsewhere in
 * this app's history. Every test captures each row's exact original
 * state first (`beforeEach`) and restores it (`afterEach`) — or deletes
 * its own temporary row if none existed before — never leaves the
 * shared dev database's real market data mutated.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("stale-data circuit breaker", () => {
  const STALE_FETCHED_AT = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago — just past the 24h threshold.
  const FRESH_FETCHED_AT = new Date(Date.now() - 1 * 60 * 60 * 1000); // 1h ago — well under the threshold.

  const failingFetch: typeof fetch = async () => new Response("rate limited", { status: 429 });

  describe("syncCryptoPrices (CoinGecko)", () => {
    const symbols = symbolsToSync();
    let originalRows: Map<string, { id: string; fetchedAt: Date } | null>;

    beforeEach(async () => {
      originalRows = new Map();
      for (const symbol of symbols) {
        const latest = await prisma.cryptoAssetPrice.findFirst({ where: { symbol }, orderBy: { asOfDate: "desc" } });
        originalRows.set(symbol, latest ? { id: latest.id, fetchedAt: latest.fetchedAt } : null);
        if (!latest) {
          await prisma.cryptoAssetPrice.create({
            data: { symbol, rate: "12000", asOfDate: new Date(), source: "test-seed" },
          });
        }
      }
    });

    afterEach(async () => {
      for (const [symbol, original] of originalRows) {
        if (original) {
          await prisma.cryptoAssetPrice.update({ where: { id: original.id }, data: { fetchedAt: original.fetchedAt } });
        } else {
          await prisma.cryptoAssetPrice.deleteMany({ where: { symbol, source: "test-seed" } });
        }
      }
    });

    async function setFetchedAtForEverySymbol(fetchedAt: Date) {
      for (const symbol of symbols) {
        const row = await prisma.cryptoAssetPrice.findFirst({ where: { symbol }, orderBy: { asOfDate: "desc" } });
        await prisma.cryptoAssetPrice.update({ where: { id: row!.id }, data: { fetchedAt } });
      }
    }

    it("does NOT throw when the fetch fails but every stored rate is still fresh (<24h)", async () => {
      await setFetchedAtForEverySymbol(FRESH_FETCHED_AT);
      const result = await syncCryptoPrices(failingFetch);
      expect(result.ok).toBe(false);
    });

    it("throws StaleDataError when the fetch fails AND the stored rate is already >24h old", async () => {
      await setFetchedAtForEverySymbol(STALE_FETCHED_AT);
      await expect(syncCryptoPrices(failingFetch)).rejects.toThrow(StaleDataError);
      await expect(syncCryptoPrices(failingFetch)).rejects.toThrow(/ETH/);
    });

    it("does NOT throw — and refreshes fetchedAt — when the fetch succeeds, even if the stored rate was already stale", async () => {
      await setFetchedAtForEverySymbol(STALE_FETCHED_AT);

      const succeedingFetch: typeof fetch = async () =>
        new Response(JSON.stringify({ ethereum: { ils: 9_999.99 } }), { status: 200 });

      const result = await syncCryptoPrices(succeedingFetch);
      expect(result.ok).toBe(true);

      const refreshed = await prisma.cryptoAssetPrice.findFirst({ where: { symbol: "ETH" }, orderBy: { asOfDate: "desc" } });
      expect(refreshed!.fetchedAt.getTime()).toBeGreaterThan(STALE_FETCHED_AT.getTime());
    });
  });

  describe("syncExchangeRates (Frankfurter)", () => {
    const currencies = currenciesToSync();
    let originalRows: Map<CurrencyCode, { id: string; fetchedAt: Date } | null>;

    beforeEach(async () => {
      originalRows = new Map();
      for (const currency of currencies) {
        const latest = await prisma.exchangeRate.findFirst({ where: { currency }, orderBy: { asOfDate: "desc" } });
        originalRows.set(currency, latest ? { id: latest.id, fetchedAt: latest.fetchedAt } : null);
        if (!latest) {
          await prisma.exchangeRate.create({
            data: { currency, rate: "3.7", asOfDate: new Date(), source: "test-seed" },
          });
        }
      }
    });

    afterEach(async () => {
      for (const [currency, original] of originalRows) {
        if (original) {
          await prisma.exchangeRate.update({ where: { id: original.id }, data: { fetchedAt: original.fetchedAt } });
        } else {
          await prisma.exchangeRate.deleteMany({ where: { currency, source: "test-seed" } });
        }
      }
    });

    async function setFetchedAtForEveryCurrency(fetchedAt: Date) {
      for (const currency of currencies) {
        const row = await prisma.exchangeRate.findFirst({ where: { currency }, orderBy: { asOfDate: "desc" } });
        await prisma.exchangeRate.update({ where: { id: row!.id }, data: { fetchedAt } });
      }
    }

    it("does NOT throw when the fetch fails but every stored rate is still fresh (<24h)", async () => {
      await setFetchedAtForEveryCurrency(FRESH_FETCHED_AT);
      const result = await syncExchangeRates(failingFetch);
      expect(result.ok).toBe(false);
    });

    it("throws StaleDataError when the fetch fails AND the stored rate is already >24h old", async () => {
      await setFetchedAtForEveryCurrency(STALE_FETCHED_AT);
      await expect(syncExchangeRates(failingFetch)).rejects.toThrow(StaleDataError);
      await expect(syncExchangeRates(failingFetch)).rejects.toThrow(/USD|EUR|GBP/);
    });
  });
});
