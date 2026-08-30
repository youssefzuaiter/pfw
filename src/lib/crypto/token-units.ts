/**
 * 18-decimal-precision on-chain token unit math (AGENTS.md §3w) — the
 * arithmetic core of the Advanced Crypto & On-Chain Asset Tracking
 * module. Pure functions, no DAL/DB access, same `src/lib/` convention
 * as every other engine (§3b).
 *
 * THE central precision hazard this file exists to avoid: 1 whole ETH is
 * 1e18 wei, which already EXCEEDS `Number.MAX_SAFE_INTEGER`
 * (~9.007e15) — converting a wei amount to a plain JS `number` at any
 * point before it's been reduced to a small enough final figure (like
 * agorot) silently loses precision below roughly 0.009 ETH worth of
 * wei, exactly the kind of float-truncation bug `money.ts`'s "money is
 * never a float" law exists to prevent for ILS, applied here to the
 * on-chain equivalent. Every function in this file that touches a raw
 * wei quantity uses `bigint` arithmetic end to end; a plain `number`
 * only ever appears for a already-small, already-safe result (an
 * exchange rate, a final agorot amount).
 */

import { agorot, type Agorot } from "../money";

export const WEI_DECIMALS = 18;
export const WEI_PER_ETHER = 10n ** BigInt(WEI_DECIMALS);

/** How many decimal digits `CryptoAssetPrice.rate` is stored with (`Decimal(20, 6)`) — kept in sync with the schema deliberately, not derived from it (Prisma's generated types don't expose column scale at runtime). */
const RATE_DECIMALS = 6;
const RATE_SCALE = 10n ** BigInt(RATE_DECIMALS);

const HEX_QUANTITY_PATTERN = /^0x[0-9a-fA-F]+$/;

/**
 * Parses a `0x`-prefixed hex string (the wire format every EVM JSON-RPC
 * quantity uses, including `eth_getBalance`'s response) into a `bigint`.
 * Rejects anything that isn't a well-formed hex quantity — an RPC
 * response is untrusted input crossing a trust boundary like any other,
 * so a malformed value must fail loudly here rather than propagate as
 * `NaN` or silently coerce to `0`.
 */
export function parseHexQuantity(hex: string): bigint {
  if (!HEX_QUANTITY_PATTERN.test(hex)) {
    throw new RangeError(`Not a valid 0x-prefixed hex quantity: ${JSON.stringify(hex)}`);
  }
  return BigInt(hex);
}

/** The inverse of `parseHexQuantity` — a non-negative `bigint` back to `0x`-prefixed lowercase hex, e.g. for constructing an RPC request parameter. */
export function toHexQuantity(value: bigint): string {
  if (value < 0n) {
    throw new RangeError(`Cannot represent a negative value as an unsigned hex quantity: ${value}`);
  }
  return `0x${value.toString(16)}`;
}

const DECIMAL_STRING_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Parses a plain decimal token-amount string (e.g. "1.5" ETH) into wei,
 * via string/BigInt arithmetic only — never `parseFloat(...) * 1e18`,
 * which would introduce exactly the float-precision artifacts this
 * whole module exists to avoid (the same reasoning `money.ts`'s
 * `parseShekelsToAgorot` already gives for agorot).
 */
export function etherStringToWei(value: string, decimals: number = WEI_DECIMALS): bigint {
  const trimmed = value.trim();
  if (!DECIMAL_STRING_PATTERN.test(trimmed)) {
    throw new RangeError(`Not a valid non-negative decimal token amount: ${JSON.stringify(value)}`);
  }

  const [wholePart, fractionPart = ""] = trimmed.split(".");
  if (fractionPart.length > decimals) {
    throw new RangeError(`Too many fractional digits (max ${decimals}): ${JSON.stringify(value)}`);
  }

  const paddedFraction = fractionPart.padEnd(decimals, "0");
  return BigInt(wholePart) * 10n ** BigInt(decimals) + BigInt(paddedFraction || "0");
}

/**
 * The inverse: wei (or any `decimals`-precision minor-unit `bigint`)
 * back to a plain decimal string ("1.5"), with no trailing zeros and no
 * trailing decimal point — via string manipulation on the `bigint`'s own
 * decimal digits, never a float division. Used for DISPLAY only; never
 * round-trip a value through this and back through `etherStringToWei`
 * for anything that needs to preserve full precision — string round-
 * tripping is exact here specifically because both directions are pure
 * digit manipulation, but a caller should still prefer keeping the
 * `bigint` itself where possible.
 */
export function weiToEtherString(wei: bigint, decimals: number = WEI_DECIMALS): string {
  if (wei < 0n) {
    throw new RangeError(`Cannot format a negative wei amount as an unsigned token string: ${wei}`);
  }

  const scale = 10n ** BigInt(decimals);
  const whole = wei / scale;
  const fraction = wei % scale;

  if (fraction === 0n) return whole.toString();

  const fractionDigits = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fractionDigits}`;
}

/**
 * Rounds `numerator / denominator` to the nearest integer, half away
 * from zero — `bigint` division truncates toward zero by default
 * (`7n / 2n === 3n`, silently dropping the remainder), which is exactly
 * wrong for converting a token value into agorot: a systematic downward
 * bias on every conversion would be a real, if small, accounting error
 * compounded across every wallet on every net-worth computation. Both
 * inputs must be non-negative — every call site in this file only ever
 * divides two already-non-negative quantities (a wei balance, a
 * positive exchange rate), so a negative-input case would indicate a
 * bug upstream worth surfacing loudly rather than silently handling.
 */
function roundedBigIntDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new RangeError(`Divisor must be positive, received ${denominator}`);
  }
  if (numerator < 0n) {
    throw new RangeError(`This function only supports non-negative numerators, received ${numerator}`);
  }
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/**
 * Converts a wei balance into `Agorot`, given an ILS-per-1-whole-unit
 * rate (the same convention `exchange-rate.ts` uses for fiat: e.g.
 * `rateIlsPerWholeUnit = 12000.50` means 1 ETH = ₪12,000.50). The rate
 * itself is a plain `number` — not itself money, same reasoning
 * `money.ts`'s `multiplyAgorot` doc comment gives — but it's converted
 * to a scaled `bigint` (matching `CryptoAssetPrice.rate`'s stored
 * `Decimal(20, 6)` precision) BEFORE it ever touches the wei `bigint`,
 * so the whole computation — wei × rate ÷ 1e18, converted to agorot ×
 * 100 — happens in exact integer arithmetic throughout. The final
 * result is always safely within `Number.MAX_SAFE_INTEGER` for any
 * realistic wallet balance (even an implausible 1,000,000 ETH holding
 * lands around 1.2 trillion agorot, ~7,500x below the safe-integer
 * ceiling) — `agorot()`'s own safe-integer assertion is what would catch
 * it if that ever weren't true, rather than this function silently
 * trusting it.
 */
export function convertWeiToAgorot(wei: bigint, rateIlsPerWholeUnit: number, decimals: number = WEI_DECIMALS): Agorot {
  if (wei < 0n) {
    throw new RangeError(`Cannot convert a negative wei balance: ${wei}`);
  }
  if (!Number.isFinite(rateIlsPerWholeUnit) || rateIlsPerWholeUnit <= 0) {
    throw new RangeError(`Rate must be a positive finite number, received ${rateIlsPerWholeUnit}`);
  }

  const rateScaled = BigInt(Math.round(rateIlsPerWholeUnit * Number(RATE_SCALE)));
  const AGOROT_PER_SHEKEL = 100n;
  const tokenScale = 10n ** BigInt(decimals);

  const numerator = wei * rateScaled * AGOROT_PER_SHEKEL;
  const denominator = tokenScale * RATE_SCALE;

  const agorotBigInt = roundedBigIntDivide(numerator, denominator);
  return agorot(Number(agorotBigInt));
}
