import { describe, expect, it, vi } from "vitest";
import type { RatePoint } from "../../lib/fx-history";
import { lockRateFor, lockRatesForDays, NoRateForDayError, toAgorotAtLockedRate } from "./lock-rate";

/** The rate a foreign-currency amount is frozen at (AGENTS.md §3www). */
function deps(points: RatePoint[]) {
  return { listRatePoints: vi.fn(async () => points), syncRateHistory: vi.fn(async () => undefined) };
}

const HISTORY: RatePoint[] = [
  { day: "2026-10-08", micros: 3_041_250 },
  { day: "2026-10-09", micros: 3_037_667 }, // Friday
  { day: "2026-10-12", micros: 3_040_001 }, // Monday
];

describe("lockRateFor", () => {
  it("locks the rate of the transaction's UTC day, as exact six-decimal text", async () => {
    expect(await lockRateFor("USD", "2026-10-09T12:00:00Z", deps(HISTORY))).toEqual({
      currency: "USD",
      micros: 3_037_667,
      rate: "3.037667",
      rateDay: "2026-10-09",
      day: "2026-10-09",
    });
  });

  it("uses the UTC day, so 23:59 and 00:01 can lock different rates", async () => {
    expect((await lockRateFor("USD", "2026-10-08T23:59:00Z", deps(HISTORY))).micros).toBe(3_041_250);
    expect((await lockRateFor("USD", "2026-10-09T00:01:00Z", deps(HISTORY))).micros).toBe(3_037_667);
  });

  it("locks Friday's rate for a weekend day and says so", async () => {
    const locked = await lockRateFor("USD", "2026-10-11T09:00:00Z", deps(HISTORY));
    expect(locked).toMatchObject({ day: "2026-10-11", rateDay: "2026-10-09", micros: 3_037_667 });
  });

  it("refuses a day before the stored history instead of guessing", async () => {
    await expect(lockRateFor("USD", "2026-10-07T12:00:00Z", deps(HISTORY))).rejects.toThrow(NoRateForDayError);
  });

  it("does not backfill when the history already covers every day", async () => {
    const d = deps(HISTORY);
    await lockRatesForDays("USD", ["2026-10-09", "2026-10-12"], d);
    expect(d.syncRateHistory).not.toHaveBeenCalled();
    expect(d.listRatePoints).toHaveBeenCalledTimes(1);
  });

  it("never locks a rate for shekels", async () => {
    await expect(lockRatesForDays("ILS", ["2026-10-09"], deps(HISTORY))).rejects.toThrow(RangeError);
  });
});

describe("toAgorotAtLockedRate", () => {
  it("converts exactly, half away from zero, the stored rate reproducing the stored agorot", async () => {
    const locked = await lockRateFor("USD", "2026-10-09", deps(HISTORY));
    // -$49.90 × 3.037667 = -151.5795833 → -₪151.58
    expect(toAgorotAtLockedRate(-4_990, locked)).toBe(-15_158);
    expect(toAgorotAtLockedRate(4_990, locked)).toBe(15_158);
  });
});
