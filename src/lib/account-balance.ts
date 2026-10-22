import { formatNativeAmount, nativeAmount, type CurrencyCode, type NativeAmount } from "./currency";
import { convertAgorotToNativeAmount, convertNativeAmountToAgorot } from "./exchange-rate";
import { agorot, type Agorot } from "./money";

/**
 * What an account holds NOW: the balance the user typed, rolled forward by the
 * transactions recorded after the day that balance was true for. One rule, used
 * by net worth, Safe to Spend and the Assets page, so the three cannot disagree
 * about the same account.
 *
 * `BankAccount.nativeBalance` is only ever the figure the user entered (at
 * creation, or when they last re-stated it). Nothing updates it as
 * transactions arrive, so reading it alone makes every balance go stale the
 * moment a statement is imported.
 */

/** An account's typed balance and the movement recorded after it, before conversion. */
export type AccountBalanceParts = {
  accountType: string;
  currency: CurrencyCode;
  /** The balance the user entered, in minor units of `currency`. For a card: money owed, positive. */
  typedNative: number;
  /** Net signed amount of live transactions after the balance day that were entered in the account's own currency, in minor units of `currency`. */
  sameCurrencyFlowNative: number;
  /** Net signed ILS amount (agorot, each row at its own frozen rate) of live transactions after the balance day that were entered in a DIFFERENT currency. */
  otherCurrencyFlowAgorot: number;
};

export type SettledBalance = {
  /** The balance now, in minor units of the account's currency. For a card: money owed (negative when overpaid). */
  currentNative: NativeAmount;
  /** `currentNative` minus the typed balance: how far the account has moved since the figure was entered. For a card, a positive number means it owes more. */
  changeNative: NativeAmount;
};

/**
 * Rolls the typed balance forward in the account's OWN currency and converts
 * once, at the latest rate, when a caller needs shekels. A live balance's
 * shekel value moves with the exchange rate (law #3), so converting the
 * opening figure at today's rate and each transaction at its own old rate (as
 * an earlier version did) let the two halves drift apart.
 *
 * Rows entered in a different currency than the account have no native amount
 * in the account's currency, so their frozen shekel amount is converted at the
 * latest rate. That is exact for the normal case (a statement imported into an
 * account is always in the account's own currency) and a small approximation
 * only for a manual entry in a third currency.
 *
 * A card stores money OWED as a positive number, so a charge (a negative
 * amount) raises it and a payment lowers it. Everything else is a plain sum.
 */
export function settleBalance(parts: AccountBalanceParts, ilsPerUnit: number): SettledBalance {
  const otherNative =
    parts.currency === "ILS"
      ? parts.otherCurrencyFlowAgorot
      : Number(convertAgorotToNativeAmount(agorot(parts.otherCurrencyFlowAgorot), parts.currency, ilsPerUnit));
  const flow = parts.sameCurrencyFlowNative + otherNative;
  const current = parts.accountType === "CREDIT_CARD" ? parts.typedNative - flow : parts.typedNative + flow;
  return {
    currentNative: nativeAmount(current),
    changeNative: nativeAmount(current - parts.typedNative),
  };
}

/** The account's balance now in shekels at the latest rate. For a card: money owed. */
export function currentBalanceAgorot(parts: AccountBalanceParts, ilsPerUnit: number): Agorot {
  return convertNativeAmountToAgorot(settleBalance(parts, ilsPerUnit).currentNative, parts.currency, ilsPerUnit);
}

/**
 * One sentence saying how an account's balance was reached, so it can be
 * checked against the bank's own figure: what the user entered, when it was
 * true, and what the transactions since have done to it.
 */
export function describeBalanceHistory(input: {
  accountType: string;
  currency: CurrencyCode;
  typedNative: number;
  changeNative: NativeAmount;
  /** The UTC day the typed balance was true for, or null when it was entered when the account was added. */
  balanceAsOf: Date | null;
}): string {
  const typed = formatNativeAmount(nativeAmount(input.typedNative), input.currency);
  const when = input.balanceAsOf ? `as of ${input.balanceAsOf.toISOString().slice(0, 10)}` : "when the account was added";
  const entered = `You entered ${typed} ${input.accountType === "CREDIT_CARD" ? "owed " : ""}${when}.`;
  if (input.changeNative === 0) return `${entered} No transactions since.`;
  const size = formatNativeAmount(nativeAmount(Math.abs(input.changeNative)), input.currency);
  if (input.accountType === "CREDIT_CARD") {
    return `${entered} Transactions since: ${size} ${input.changeNative > 0 ? "more" : "less"} owed.`;
  }
  return `${entered} Transactions since: ${input.changeNative > 0 ? "+" : "-"}${size}.`;
}
