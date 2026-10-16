import "server-only";
import { withUserScope } from "../db/with-user-scope";
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
 * Every bank account with the net signed ILS amount of the live
 * transactions recorded on it AFTER it was created (Safe to Spend,
 * `src/lib/safe-to-spend.ts`).
 *
 * `BankAccount.nativeBalance` is only ever the figure entered when the
 * account was created (see `createBankAccount`); nothing updates it as
 * transactions arrive. The balance an account has NOW is that opening figure
 * plus everything that moved after it, so this is the missing half.
 *
 * Transactions dated at or before the account's "balance as of" day (or, with
 * none, before it was created) are already part of the opening balance: a
 * statement imported later for an earlier period must not move it a second
 * time, and neither must a transaction the typed figure already reflects. Transfers ARE included: they move a real account's
 * balance, and the two legs of a transfer between the user's own accounts
 * cancel in the total. Soft-deleted rows are not.
 *
 * The flow is in ILS agorot, each row at its own frozen rate, while the
 * opening balance is converted at the latest rate by the caller. For a
 * foreign-currency account the two differ by exchange-rate drift, a small
 * and deliberate approximation: the alternative is re-deriving every row in
 * the account's own currency, which a manual entry in a third currency does
 * not even have.
 */
export async function listAccountsWithFlowSinceCreation(userId: string) {
  return withUserScope(userId, async (tx) => {
    const accounts = await tx.bankAccount.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
    const sums = await Promise.all(
      accounts.map((account) =>
        tx.notableTransaction.aggregate({
          where: { userId, bankAccountId: account.id, occurredAt: rollForwardFilter(account), ...LIVE },
          _sum: { amount: true },
        }),
      ),
    );
    return accounts.map((account, index) => ({
      accountType: account.accountType,
      currency: account.currency,
      nativeBalance: account.nativeBalance,
      flowSinceCreation: sums[index]._sum.amount ?? 0n,
    }));
  });
}
