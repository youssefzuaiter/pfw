import "server-only";
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
