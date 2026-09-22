import { describe, expect, it, vi } from "vitest";
import type { CurrencyCode } from "../../lib/currency";
import { type ImportRateSource, NoExchangeRateError, resolveImportRate } from "./transaction-import";

/**
 * The rate gate in front of a foreign-currency statement import, tested
 * against a fake source: `ExchangeRate` is a global table, so the "no
 * rate exists yet" state can't be arranged in the shared dev database
 * without racing every other test that reads the real rows. The write
 * path itself has integration coverage in
 * tests/integration/transaction-import-currency.test.ts.
 */
type FakeSource = {
  getLatestRateFetchedAt: ReturnType<typeof vi.fn<ImportRateSource["getLatestRateFetchedAt"]>>;
  getLatestRateTable: ReturnType<typeof vi.fn<ImportRateSource["getLatestRateTable"]>>;
  syncRates: ReturnType<typeof vi.fn<ImportRateSource["syncRates"]>>;
};

function fakeSource(overrides: Partial<FakeSource> = {}): FakeSource {
  const table: Record<CurrencyCode, number> = { ILS: 1, USD: 3.7, EUR: 4, GBP: 4.7, TRY: 0.09 };
  return {
    getLatestRateFetchedAt: vi.fn<ImportRateSource["getLatestRateFetchedAt"]>(async () => new Date()),
    getLatestRateTable: vi.fn<ImportRateSource["getLatestRateTable"]>(async () => table),
    syncRates: vi.fn<ImportRateSource["syncRates"]>(async () => undefined),
    ...overrides,
  };
}

describe("resolveImportRate", () => {
  it("returns null for ILS without consulting the source at all", async () => {
    const source = fakeSource();
    expect(await resolveImportRate("ILS", source)).toBeNull();
    expect(source.getLatestRateFetchedAt).not.toHaveBeenCalled();
    expect(source.getLatestRateTable).not.toHaveBeenCalled();
    expect(source.syncRates).not.toHaveBeenCalled();
  });

  it("returns the stored rate without syncing when one already exists", async () => {
    const source = fakeSource();
    expect(await resolveImportRate("TRY", source)).toBe(0.09);
    expect(source.syncRates).not.toHaveBeenCalled();
  });

  it("syncs exactly once on demand when nothing has been stored yet, then uses the freshly stored rate", async () => {
    let stored = false;
    const source = fakeSource({
      getLatestRateFetchedAt: vi.fn<ImportRateSource["getLatestRateFetchedAt"]>(async () => (stored ? new Date() : null)),
      syncRates: vi.fn<ImportRateSource["syncRates"]>(async () => {
        stored = true;
      }),
    });
    expect(await resolveImportRate("TRY", source)).toBe(0.09);
    expect(source.syncRates).toHaveBeenCalledTimes(1);
  });

  it("refuses with NoExchangeRateError when no rate exists and the sync produces none — never the fallback guess", async () => {
    const source = fakeSource({ getLatestRateFetchedAt: vi.fn<ImportRateSource["getLatestRateFetchedAt"]>(async () => null) });
    await expect(resolveImportRate("TRY", source)).rejects.toThrow(NoExchangeRateError);
    await expect(resolveImportRate("TRY", source)).rejects.toThrow(/TRY/);
    // The table (which would have handed back FALLBACK_RATES.TRY) is
    // never even consulted on this path.
    expect(source.getLatestRateTable).not.toHaveBeenCalled();
  });

  it("treats a THROWING sync (e.g. the stale-data circuit breaker firing for another currency) as 'no rate arrived', not as its own error", async () => {
    const source = fakeSource({
      getLatestRateFetchedAt: vi.fn<ImportRateSource["getLatestRateFetchedAt"]>(async () => null),
      syncRates: vi.fn<ImportRateSource["syncRates"]>(async () => {
        throw new Error("StaleDataError: USD is 30h old");
      }),
    });
    await expect(resolveImportRate("TRY", source)).rejects.toThrow(NoExchangeRateError);
  });

  it("still succeeds when the sync throws but DID store the wanted rate before failing", async () => {
    let stored = false;
    const source = fakeSource({
      getLatestRateFetchedAt: vi.fn<ImportRateSource["getLatestRateFetchedAt"]>(async () => (stored ? new Date() : null)),
      syncRates: vi.fn<ImportRateSource["syncRates"]>(async () => {
        stored = true;
        throw new Error("partial failure after the upsert");
      }),
    });
    expect(await resolveImportRate("TRY", source)).toBe(0.09);
  });
});
