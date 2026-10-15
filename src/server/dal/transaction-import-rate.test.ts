import { describe, expect, it, vi } from "vitest";
import type { RatePoint } from "../../lib/fx-history";
import { NoExchangeRateError, resolveImportRates } from "./transaction-import";

/**
 * The rate gate in front of a foreign-currency statement import, tested
 * against a fake source: `ExchangeRate` is a global table, so the "no
 * rate exists yet" state can't be arranged in the shared dev database
 * without racing every other test that reads the real rows. The write
 * path itself has integration coverage in
 * tests/integration/transaction-import-currency.test.ts.
 */
function fakeSource(points: RatePoint[], afterSync: RatePoint[] = points) {
  let synced = false;
  return {
    listRatePoints: vi.fn(async () => (synced ? afterSync : points)),
    syncRateHistory: vi.fn(async () => {
      synced = true;
    }),
  };
}

const HISTORY: RatePoint[] = [
  { day: "2026-08-28", micros: 90_000 }, // Friday
  { day: "2026-08-31", micros: 95_000 }, // Monday
];

describe("resolveImportRates", () => {
  it("returns null for ILS without consulting the source at all", async () => {
    const source = fakeSource(HISTORY);
    expect(await resolveImportRates("ILS", ["2026-08-29"], source)).toBeNull();
    expect(source.listRatePoints).not.toHaveBeenCalled();
  });

  it("locks each day at its own rate, a weekend at Friday's", async () => {
    const rates = await resolveImportRates("TRY", ["2026-08-28", "2026-08-30", "2026-08-31", "2026-09-04"], fakeSource(HISTORY));
    expect(rates?.get("2026-08-28")).toMatchObject({ micros: 90_000, rate: "0.090000", rateDay: "2026-08-28" });
    expect(rates?.get("2026-08-30")).toMatchObject({ micros: 90_000, rateDay: "2026-08-28" });
    expect(rates?.get("2026-08-31")).toMatchObject({ micros: 95_000, rate: "0.095000" });
    // A day past the newest stored rate takes the newest one.
    expect(rates?.get("2026-09-04")).toMatchObject({ micros: 95_000, rateDay: "2026-08-31" });
  });

  it("backfills once when no history is stored, then uses it", async () => {
    const source = fakeSource([], HISTORY);
    const rates = await resolveImportRates("TRY", ["2026-08-31"], source);
    expect(source.syncRateHistory).toHaveBeenCalledTimes(1);
    expect(rates?.get("2026-08-31")?.micros).toBe(95_000);
  });

  it("refuses with NoExchangeRateError when there is still no rate — never the fallback guess", async () => {
    const source = fakeSource([]);
    await expect(resolveImportRates("TRY", ["2026-08-31"], source)).rejects.toThrow(NoExchangeRateError);
    await expect(resolveImportRates("TRY", ["2026-08-31"], source)).rejects.toThrow(/TRY.*2026-08-31/);
  });

  it("refuses a statement with a row dated before the stored history, naming the day", async () => {
    const source = fakeSource(HISTORY);
    await expect(resolveImportRates("TRY", ["2026-08-31", "2026-08-27"], source)).rejects.toMatchObject({
      code: "no_exchange_rate",
      day: "2026-08-27",
    });
    // It tried to backfill first.
    expect(source.syncRateHistory).toHaveBeenCalled();
  });
});
