import "server-only";
import type { CurrencyCode } from "../../lib/currency";
import type { AccountBalanceParts } from "../../lib/account-balance";
import { withUserScope, type ScopedTransactionClient } from "../db/with-user-scope";
import { LIVE } from "./transactions";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Where an account's roll-forward starts. A typed balance with a "balance as
 * of" day already includes every transaction dated on or before that UTC day,
 * so only rows from the next day on move it. An account with no such day
 * (every account made before the column existed) falls back to the moment it
 * was created.
 */
export function rollForwardFilter(account: { balanceAsOf: Date | null; createdAt: Date }) {
  if (account.balanceAsOf === null) return { gt: account.createdAt };
  const day = account.balanceAsOf;
  return { gte: new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) + DAY_MS) };
}

/**
 * Every bank account with its typed balance and the movement recorded after
 * it (`src/lib/account-balance.ts` turns the two into the balance NOW). Reads
 * inside the CALLER's transaction, so a figure built from accounts and
 * holdings together (net worth) comes from one moment.
 *
 * `BankAccount.nativeBalance` is only ever the figure entered when the
 * account was created or last re-stated; nothing updates it as transactions
 * arrive. The balance an account has now is that figure plus everything that
 * moved after it, so this is the missing half.
 *
 * Transactions dated at or before the account's "balance as of" day (or, with
 * none, before it was created) are already part of the typed balance: a
 * statement imported later for an earlier period must not move it a second
 * time, and neither must a transaction the typed figure already reflects.
 * Transfers ARE included: they move a real account's balance, and the two
 * legs of a transfer between the user's own accounts cancel in the total.
 * Soft-deleted rows are not.
 *
 * The movement is split by currency: rows entered in the account's own
 * currency are summed natively (exact, and unaffected by exchange-rate
 * drift), and rows entered in another currency are summed in their frozen
 * shekel amount for the caller to convert. A transaction's native amount is
 * in ITS currency, so adding it to an account in a different one would be
 * wrong.
 */
export async function loadAccountBalanceParts(tx: ScopedTransactionClient, userId: string) {
  const accounts = await tx.bankAccount.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  const sums = await Promise.all(
    accounts.map(async (account) => {
      const after = { userId, bankAccountId: account.id, occurredAt: rollForwardFilter(account), ...LIVE };
      const [same, other] = await Promise.all([
        tx.notableTransaction.aggregate({ where: { ...after, currency: account.currency }, _sum: { nativeAmount: true } }),
        tx.notableTransaction.aggregate({ where: { ...after, currency: { not: account.currency } }, _sum: { amount: true } }),
      ]);
      return { same: same._sum.nativeAmount ?? 0n, other: other._sum.amount ?? 0n };
    }),
  );
  return accounts.map((account, index) => ({
    account,
    parts: {
      accountType: account.accountType,
      currency: account.currency as CurrencyCode,
      typedNative: Number(account.nativeBalance),
      sameCurrencyFlowNative: Number(sums[index].same),
      otherCurrencyFlowAgorot: Number(sums[index].other),
    } satisfies AccountBalanceParts,
  }));
}

/** The same, in a transaction of its own. */
export async function listAccountBalanceParts(userId: string) {
  return withUserScope(userId, (tx) => loadAccountBalanceParts(tx, userId));
}
