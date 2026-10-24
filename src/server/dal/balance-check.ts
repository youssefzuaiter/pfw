import { checkBalance, type BalanceCheckResult, type MovementRow } from "../../lib/balance-check";
import type { CurrencyCode } from "../../lib/currency";
import { convertAgorotToNativeAmount } from "../../lib/exchange-rate";
import { agorot } from "../../lib/money";
import { withUserScope } from "../db/with-user-scope";
import { rollForwardFilter } from "./account-balances";
import { getLatestRateTable } from "./exchange-rates";
import { LIVE } from "./transactions";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ROWS = 5_000;

const dayOf = (date: Date): string => date.toISOString().slice(0, 10);
const startOfUtcDay = (date: Date): Date => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

export type BalanceCheckRowDetail = { id: string; day: string; label: string; deltaNative: number };

export type BalanceCheckOutcome =
  | {
      ok: true;
      accountLabel: string;
      accountType: string;
      currency: CurrencyCode;
      /** The day the checked balance is for, `YYYY-MM-DD`. */
      day: string;
      /** The balance the user entered and the day it was true for (or "when added"). */
      typedNative: number;
      typedAsOf: string | null;
      result: BalanceCheckResult;
      /** The rows named by the causes, so they can be shown. */
      rows: BalanceCheckRowDetail[];
      /** How many transactions the app's figure is built from. */
      movementCount: number;
      /** Some of those were entered in another currency, so the app's figure is approximate. */
      approximate: boolean;
    }
  | { ok: false; error: "not_found" }
  | { ok: false; error: "in_future" }
  | { ok: false; error: "before_balance_date"; earliest: string };

/**
 * Works out what the app says an account held at the end of `day` and compares
 * it with the bank's figure (AGENTS.md §3oooo). Writes nothing. Not found for
 * another user's account, like every DAL lookup.
 *
 * The app's figure is the balance the user entered plus the live transactions
 * after the day that balance was true for, up to and including `day`
 * (transfers included: they move a balance; deleted rows are not). A day
 * before that balance was true for cannot be checked, since the movement
 * between is not part of the figure.
 */
export async function checkAccountBalance(
  userId: string,
  accountId: string,
  input: { bankNative: number; day: Date; now?: Date },
): Promise<BalanceCheckOutcome> {
  const now = input.now ?? new Date();
  const day = startOfUtcDay(input.day);
  if (day.getTime() > startOfUtcDay(now).getTime()) return { ok: false, error: "in_future" };

  const rateTable = await getLatestRateTable(now);

  return withUserScope(userId, async (tx): Promise<BalanceCheckOutcome> => {
    const account = await tx.bankAccount.findFirst({ where: { id: accountId, userId } });
    if (!account) return { ok: false, error: "not_found" };

    const earliest = startOfUtcDay(account.balanceAsOf ?? account.createdAt);
    if (day.getTime() < earliest.getTime()) return { ok: false, error: "before_balance_date", earliest: dayOf(earliest) };

    const after = rollForwardFilter(account);
    const rows = await tx.notableTransaction.findMany({
      where: { userId, bankAccountId: accountId, ...LIVE, occurredAt: { ...after, lt: new Date(day.getTime() + DAY_MS) } },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: MAX_ROWS,
      select: { id: true, occurredAt: true, currency: true, nativeAmount: true, amount: true, merchantName: true, description: true },
    });

    const isCard = account.accountType === "CREDIT_CARD";
    const rate = rateTable[account.currency as CurrencyCode];
    let approximate = false;
    const movement: (MovementRow & { label: string })[] = rows.map((row) => {
      let signed: number;
      if (row.currency === account.currency) {
        signed = Number(row.nativeAmount);
      } else {
        approximate = true;
        signed = account.currency === "ILS" ? Number(row.amount) : Number(convertAgorotToNativeAmount(agorot(Number(row.amount)), account.currency as CurrencyCode, rate));
      }
      return { id: row.id, day: dayOf(row.occurredAt), label: (row.merchantName ?? row.description).trim(), deltaNative: isCard ? -signed : signed };
    });

    const typedNative = Number(account.nativeBalance);
    const result = checkBalance({ typedNative, rows: movement, bankNative: input.bankNative });

    const named = new Set<string>();
    for (const cause of result.causes) {
      if ("rowId" in cause) named.add(cause.rowId);
      if (cause.kind === "duplicate") named.add(cause.twinId);
    }
    return {
      ok: true,
      accountLabel: account.nickname ?? account.institutionName,
      accountType: account.accountType,
      currency: account.currency as CurrencyCode,
      day: dayOf(day),
      typedNative,
      typedAsOf: account.balanceAsOf ? dayOf(account.balanceAsOf) : null,
      result,
      rows: movement.filter((row) => named.has(row.id)).map((row) => ({ id: row.id, day: row.day, label: row.label, deltaNative: row.deltaNative })),
      movementCount: movement.length,
      approximate,
    };
  });
}
