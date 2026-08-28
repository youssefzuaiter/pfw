import "server-only";
import { withUserScope } from "../db/with-user-scope";

export async function listBudgets(userId: string) {
  return withUserScope(userId, (tx) =>
    tx.budget.findMany({ where: { userId }, include: { category: true }, orderBy: { category: { name: "asc" } } }),
  );
}

/** See bank-accounts.ts for why this returns `null` rather than throwing on a mismatch. */
export async function getBudgetById(userId: string, id: string) {
  return withUserScope(userId, (tx) => tx.budget.findFirst({ where: { id, userId }, include: { category: true } }));
}

/** Create-or-update: one budget per (user, category) — schema.prisma's `@@unique([userId, categoryId])`. Returns `null` if the category isn't the caller's. */
export async function upsertBudget(userId: string, categoryId: string, monthlyLimit: bigint) {
  return withUserScope(userId, async (tx) => {
    const category = await tx.category.findFirst({ where: { id: categoryId, userId } });
    if (!category) return null;

    return tx.budget.upsert({
      where: { userId_categoryId: { userId, categoryId } },
      create: { userId, categoryId, monthlyLimit },
      update: { monthlyLimit },
      include: { category: true },
    });
  });
}

export async function deleteBudget(userId: string, id: string) {
  return withUserScope(userId, async (tx) => {
    const existing = await tx.budget.findFirst({ where: { id, userId } });
    if (!existing) return null;
    await tx.budget.delete({ where: { id } });
    return existing;
  });
}
