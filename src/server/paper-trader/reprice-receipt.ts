import { type Agorot } from "../../lib/money";
import { nativeAmount, type CurrencyCode, type NativeAmount } from "../../lib/currency";
import { convertNativeAmountToAgorot } from "../../lib/exchange-rate";

/**
 * Re-prices a trade receipt's native (USD) execution price into agorot
 * using THIS app's own exchange rate, not the one the trader sent (ad
 * hoc, trader integration hardening).
 *
 * The Tier-0 agent's receipt carries `price_agorot`/`total_agorot`/
 * `exchange_rate_at_entry`, computed from a fixed `USD_ILS_RATE=3.7` in
 * its own `.env`. Trusting those meant every paper trade was booked at a
 * fictional rate while the rest of this app converts at the
 * Frankfurter-synced one (§3l) — ILS P&L off by the real-vs-3.7 gap.
 * Law #3 says a trade converts ONCE, at execution, at the real rate;
 * this is where that happens for receipts. The agent's figures are
 * still accepted by the schema (backward compatible) and compared here
 * so a drift beyond `DRIFT_WARNING_RATIO` is logged, but they never
 * touch money.
 *
 * Pure so it's unit-testable with literals (`src/lib/` convention, §3b):
 * the route fetches the rate table and passes the rate in.
 */
export const DRIFT_WARNING_RATIO = 0.02;

export type RepricedReceipt = {
  priceAgorot: Agorot;
  nativePriceAmount: NativeAmount;
  exchangeRate: number;
  /** Set when the trader's own rate differs from ours by more than `DRIFT_WARNING_RATIO`; the route logs it. */
  driftWarning: string | null;
};

export function repriceReceipt(input: {
  nativePriceMinorUnits: number;
  currency: CurrencyCode;
  ourRate: number;
  traderRate: number;
}): RepricedReceipt {
  const native = nativeAmount(input.nativePriceMinorUnits);
  const priceAgorot = convertNativeAmountToAgorot(native, input.currency, input.ourRate);
  const exchangeRate = input.currency === "ILS" ? 1 : input.ourRate;

  let driftWarning: string | null = null;
  if (input.currency !== "ILS" && Number.isFinite(input.traderRate) && input.traderRate > 0) {
    const drift = Math.abs(input.traderRate - input.ourRate) / input.ourRate;
    if (drift > DRIFT_WARNING_RATIO) {
      driftWarning = `trader sent ${input.currency}/ILS ${input.traderRate}, booked at synced rate ${input.ourRate} (${(drift * 100).toFixed(1)}% apart)`;
    }
  }

  return { priceAgorot, nativePriceAmount: native, exchangeRate, driftWarning };
}
