"use client";

import { useEffect, useState } from "react";
import { BASE_CURRENCY, CURRENCY_SYMBOLS, parseDecimalToNativeAmount, type CurrencyCode } from "../currency";
import { convertNativeToAgorotExact } from "../fx-history";
import { formatAgorot, agorot } from "../money";

/** What `GET /api/exchange-rates/on` answers: the rate a transaction on `day` would be locked at. */
export type LockedRatePreview = { micros: number; rate: string; rateDay: string; day: string };

export type EnteredAmountState = {
  /**
   * - `shekels`: nothing to convert.
   * - `loading`: the rate for this currency and day is being fetched.
   * - `ready`: the rate is known; `expectedAmountAgorot` is set when an amount is typed.
   * - `error`: no rate for that day, or the amount can't be converted.
   */
  status: "shekels" | "loading" | "ready" | "error";
  /** The exact signed agorot the server will store, as a string, or null. */
  expectedAmountAgorot: string | null;
  /** One line for the form to show beneath the amount, or null. */
  message: string | null;
  /** Fetch the rate again (after the server answered "rate changed"). */
  refresh: () => void;
};

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type Fetched = { key: string; locked?: LockedRatePreview; error?: string };

/** "₪3.037667 per $1": the exact rate the ledger will store, never rounded for display. */
export function describeLockedRate(locked: Pick<LockedRatePreview, "rate">, currency: CurrencyCode): string {
  return `₪${locked.rate} per ${CURRENCY_SYMBOLS[currency]}1`;
}

/**
 * The shekel figure an amount typed in another currency will be stored
 * as (AGENTS.md §3www). The rate comes from the server, which locks the
 * same rate again on submit; the conversion here is the same exact
 * function the server uses, so the preview and the stored figure can only
 * differ if a rate sync ran in between, and the server refuses that case
 * (409) instead of storing a number the user never saw.
 *
 * `amount` is the unsigned text in the form; `negative` gives the sign.
 * `day` is the transaction date as YYYY-MM-DD (a UTC day, which is how the
 * date field's value is sent).
 */
export function useEnteredAmount({
  currency,
  amount,
  negative,
  day,
}: {
  currency: CurrencyCode;
  amount: string;
  negative: boolean;
  day: string;
}): EnteredAmountState {
  const [nonce, setNonce] = useState(0);
  const [fetched, setFetched] = useState<Fetched | null>(null);
  const isForeign = currency !== BASE_CURRENCY;
  const key = isForeign && DAY_PATTERN.test(day) ? `${currency}|${day}|${nonce}` : null;

  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const query = new URLSearchParams({ currency, day });
        const response = await fetch(`/api/exchange-rates/on?${query.toString()}`, { signal: controller.signal });
        const body = await response.json().catch(() => ({}));
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setFetched({ key, error: typeof body.error === "string" ? body.error : "Couldn't load the exchange rate." });
        } else {
          setFetched({ key, locked: body as LockedRatePreview });
        }
      } catch {
        if (!controller.signal.aborted) setFetched({ key, error: "Couldn't load the exchange rate." });
      }
    })();
    return () => controller.abort();
  }, [key, currency, day]);

  const refresh = () => setNonce((n) => n + 1);

  if (!isForeign) return { status: "shekels", expectedAmountAgorot: null, message: null, refresh };
  if (!key) return { status: "error", expectedAmountAgorot: null, message: "Pick a date to see the exchange rate.", refresh };
  if (!fetched || fetched.key !== key) {
    return { status: "loading", expectedAmountAgorot: null, message: "Loading the exchange rate…", refresh };
  }
  if (fetched.error || !fetched.locked) {
    return { status: "error", expectedAmountAgorot: null, message: fetched.error ?? "Couldn't load the exchange rate.", refresh };
  }

  const locked = fetched.locked;
  const rateNote = `${describeLockedRate(locked, currency)}, rate of ${locked.rateDay}`;
  const unsigned = amount.trim().replace(/^-/, "");
  if (unsigned === "") return { status: "ready", expectedAmountAgorot: null, message: rateNote, refresh };

  let native: number;
  try {
    native = parseDecimalToNativeAmount(unsigned);
  } catch {
    return { status: "error", expectedAmountAgorot: null, message: "Enter an amount like 49.90.", refresh };
  }
  const signed = negative ? -native : native;
  const amountAgorot = convertNativeToAgorotExact(signed, locked.micros);
  if (amountAgorot === 0) {
    return { status: "error", expectedAmountAgorot: null, message: "That amount is too small to record in shekels.", refresh };
  }
  return {
    status: "ready",
    expectedAmountAgorot: String(amountAgorot),
    message: `Records as ${formatAgorot(agorot(Math.abs(amountAgorot)))} at ${rateNote}.`,
    refresh,
  };
}
