import "server-only";
import { agorot } from "../../lib/money";
import { nativeAmount } from "../../lib/currency";
import type { AnnouncedDividend, PaidDividend } from "../../lib/portfolio-analytics";
import { withUserScope } from "../db/with-user-scope";

export async function listDividends(userId: string) {
  return withUserScope(userId, (tx) =>
    tx.dividend.findMany({ where: { userId }, orderBy: { payDate: "desc" } }),
  );
}

/**
 * Declared-but-unpaid dividends, in the shape the analytics engine wants.
 * The projected payout is deliberately NOT computed here — it depends on
 * today's quantity and today's FX rate, so it belongs in
 * `buildUpcomingPayouts`, not in a stored or DAL-computed value.
 */
export async function listAnnouncedDividends(userId: string): Promise<AnnouncedDividend[]> {
  const rows = await withUserScope(userId, (tx) =>
    tx.dividend.findMany({ where: { userId, status: "ANNOUNCED" }, orderBy: { payDate: "asc" } }),
  );

  return rows.map((row) => ({
    symbol: row.symbol,
    currency: row.currency,
    amountPerShareNative: nativeAmount(Number(row.amountPerShareNative)),
    exDate: row.exDate,
    payDate: row.payDate,
  }));
}

/**
 * Dividends actually received. `totalAgorot` is non-null for every PAID
 * row by construction (see `recordDividendPayment` and the Dividend model
 * comment) — a PAID row missing it would be a data-integrity bug, so this
 * coerces a null to 0 rather than silently dropping the row, which would
 * understate income with no signal that anything was wrong.
 */
export async function listPaidDividends(userId: string): Promise<PaidDividend[]> {
  const rows = await withUserScope(userId, (tx) =>
    tx.dividend.findMany({ where: { userId, status: "PAID" }, orderBy: { payDate: "desc" } }),
  );

  return rows.map((row) => ({
    symbol: row.symbol,
    totalAgorot: agorot(Number(row.totalAgorot ?? 0n)),
    payDate: row.payDate,
  }));
}

export type RecordDividendInput = {
  portfolioHoldingId: string;
  symbol: string;
  currency: "ILS" | "USD" | "EUR" | "GBP";
  amountPerShareNative: number;
  exDate: Date;
  payDate: Date;
};

/**
 * Records a newly-declared (unpaid) dividend. Idempotent on
 * (userId, symbol, exDate) — a given instrument declares exactly one
 * dividend per ex-date, so re-running a sync or a seed must update that
 * row rather than accumulate duplicates that would double-count income
 * the moment they were marked paid.
 */
export async function upsertAnnouncedDividend(userId: string, input: RecordDividendInput) {
  return withUserScope(userId, (tx) =>
    tx.dividend.upsert({
      where: { userId_symbol_exDate: { userId, symbol: input.symbol, exDate: input.exDate } },
      create: {
        userId,
        portfolioHoldingId: input.portfolioHoldingId,
        symbol: input.symbol,
        currency: input.currency,
        amountPerShareNative: BigInt(input.amountPerShareNative),
        exDate: input.exDate,
        payDate: input.payDate,
        status: "ANNOUNCED",
      },
      update: {
        amountPerShareNative: BigInt(input.amountPerShareNative),
        payDate: input.payDate,
      },
    }),
  );
}

export type SettleDividendInput = {
  dividendId: string;
  quantityAtPayment: number;
  totalNativeAmount: number;
  totalAgorot: number;
  exchangeRate: number;
};

/**
 * Marks an announced dividend as PAID, freezing the amount received, the
 * share count it was paid on, and the FX rate used — all historical facts
 * from this point on, never recomputed (see the Dividend model comment).
 *
 * Scoped by `userId` in the `where` as well as going through RLS, per the
 * project's belt-and-braces convention: `updateMany` (not `update`) is
 * used specifically so the id can be constrained by userId in the same
 * clause — `update` accepts only a unique field, which would mean
 * trusting the id alone.
 */
export async function settleDividend(userId: string, input: SettleDividendInput) {
  return withUserScope(userId, (tx) =>
    tx.dividend.updateMany({
      where: { id: input.dividendId, userId, status: "ANNOUNCED" },
      data: {
        status: "PAID",
        quantityAtPayment: input.quantityAtPayment.toString(),
        totalNativeAmount: BigInt(input.totalNativeAmount),
        totalAgorot: BigInt(input.totalAgorot),
        exchangeRateAtEntry: input.exchangeRate.toString(),
      },
    }),
  );
}
