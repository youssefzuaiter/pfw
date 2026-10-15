import "server-only";
import { BASE_CURRENCY, type CurrencyCode } from "../../lib/currency";
import { convertNativeToAgorotExact, formatRateMicros, rateOnDay, utcDayKey, type RatePoint } from "../../lib/fx-history";
import { listRatePoints } from "../dal/exchange-rates";
import { syncRateHistory } from "./rate-sync";

/**
 * The exchange rate a foreign-currency amount is converted at when it
 * enters the ledger (AGENTS.md §3www): the newest published rate on or
 * before the transaction's UTC day. A weekend or holiday takes the last
 * business day's rate, the same rule every past figure is shown with.
 *
 * Unlike a displayed figure, this one is frozen into `amount` and
 * `exchangeRateAtEntry` forever, so it must be a REAL stored rate: a day
 * before the stored history, or a currency with no history at all, is
 * refused rather than converted at a guess. The same rule statement
 * imports follow.
 */
export type LockedRate = {
  currency: CurrencyCode;
  /** ILS per 1 unit, in millionths. */
  micros: number;
  /** The same rate as the exact six-decimal text the database stores. */
  rate: string;
  /** The day the rate was published (a Friday for a weekend day). */
  rateDay: string;
  /** The UTC day it was locked for. */
  day: string;
};

export class NoRateForDayError extends Error {
  readonly code = "no_rate_for_day";
  constructor(
    readonly currency: CurrencyCode,
    readonly day: string,
  ) {
    super(`No ${currency} exchange rate is stored for ${day} or any day before it, so the amount can't be converted to shekels.`);
    this.name = "NoRateForDayError";
  }
}

export type LockRateDeps = {
  listRatePoints: (currency: CurrencyCode) => Promise<RatePoint[]>;
  syncRateHistory: () => Promise<unknown>;
};

const DEFAULT_DEPS: LockRateDeps = {
  listRatePoints,
  syncRateHistory: () => syncRateHistory(),
};

/**
 * Locks the rate for each requested day of one currency. Reads the history
 * once; if none is stored yet (a fresh deployment before its first nightly
 * sync) it backfills once and reads again. Throws `NoRateForDayError` for
 * the first day that has no real rate on or before it.
 */
export async function lockRatesForDays(
  currency: CurrencyCode,
  days: readonly string[],
  deps: LockRateDeps = DEFAULT_DEPS,
): Promise<Map<string, LockedRate>> {
  if (currency === BASE_CURRENCY) throw new RangeError("Shekels need no exchange rate");
  let points = await deps.listRatePoints(currency);
  if (points.length === 0 || days.some((day) => day < points[0].day)) {
    // Never throws; on failure the reload below simply finds nothing new.
    await deps.syncRateHistory();
    points = await deps.listRatePoints(currency);
  }
  const locked = new Map<string, LockedRate>();
  for (const day of days) {
    if (locked.has(day)) continue;
    const found = rateOnDay(points, day, 1);
    if (found.approximate || found.rateDay === null) throw new NoRateForDayError(currency, day);
    locked.set(day, { currency, micros: found.micros, rate: formatRateMicros(found.micros), rateDay: found.rateDay, day });
  }
  return locked;
}

/** The rate for one instant's UTC day. */
export async function lockRateFor(currency: CurrencyCode, occurredAt: Date | string, deps?: LockRateDeps): Promise<LockedRate> {
  const day = utcDayKey(occurredAt);
  return (await lockRatesForDays(currency, [day], deps)).get(day)!;
}

/** An amount in `currency`'s minor units, converted at a locked rate to agorot, exactly. */
export function toAgorotAtLockedRate(nativeAmount: number | bigint, locked: LockedRate): number {
  return convertNativeToAgorotExact(nativeAmount, locked.micros);
}
