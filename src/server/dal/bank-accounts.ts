import "server-only";
import type { Prisma } from "../../generated/prisma/client";
import { withUserScope } from "../db/with-user-scope";

/**
 * Returns `null` both when the account doesn't exist AND when it belongs
 * to a different user — the two cases are indistinguishable on purpose
 * (Section 2.2: IDOR responses must never leak existence via a different
 * status/shape for "not found" vs "not yours").
 */
export async function getBankAccountById(userId: string, id: string) {
  return withUserScope(userId, (tx) => tx.bankAccount.findFirst({ where: { id, userId } }));
}

export async function listBankAccounts(userId: string) {
  return withUserScope(userId, (tx) =>
    tx.bankAccount.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
  );
}

/**
 * Manual bank-account creation — closes a real gap: before this, the
 * ONLY thing that ever created a `BankAccount` row was the seed script
 * or the mock Open Banking (PSD2) connect flow (`linkBankConnection`,
 * §3oo), and that flow hardcodes `nativeBalance: 0n` with nothing ever
 * updating it afterward. A brand-new real user (post-§3ff auth) had no
 * path at all to a nonzero net worth via a bank account. `nativeBalance`
 * here is a one-time opening balance the user reports directly — same
 * "a live balance is what the account holder says it is" trust level a
 * real bank-linking flow would give you at connect time, just entered by
 * hand instead of fetched from an API. `last4` is encrypted at rest
 * transparently by the existing field-encryption extension, same as
 * every other write to this column.
 */
export async function createBankAccount(
  userId: string,
  input: {
    institutionName: string;
    last4: string;
    accountType: Prisma.BankAccountCreateInput["accountType"];
    nickname?: string;
    currency?: Prisma.BankAccountCreateInput["currency"];
    nativeBalance: bigint;
  },
) {
  return withUserScope(userId, (tx) =>
    tx.bankAccount.create({
      data: {
        userId,
        institutionName: input.institutionName,
        last4: input.last4,
        accountType: input.accountType,
        nickname: input.nickname,
        currency: input.currency ?? "ILS",
        nativeBalance: input.nativeBalance,
      },
    }),
  );
}
