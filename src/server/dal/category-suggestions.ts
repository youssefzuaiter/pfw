import "server-only";
import { withUserScope } from "../db/with-user-scope";
import { REAL_MONEY } from "./transactions";

/**
 * What the AI category suggestions need (AGENTS.md §3kkk): the user's live,
 * non-transfer transactions still in Uncategorized, newest first, and the
 * categories they could move to. A transfer between the user's own accounts
 * is left out: it is not spending, so it has no spending category to find.
 *
 * `description` is decrypted by the field-encryption extension like every
 * other read here. `total` counts every such row; `rows` stops at `limit`.
 */
export async function listUncategorizedForSuggestions(userId: string, limit: number) {
  return withUserScope(userId, async (tx) => {
    const categories = await tx.category.findMany({ where: { userId, archivedAt: null }, orderBy: { name: "asc" } });
    const uncategorized = categories.find((category) => category.isUncategorized);
    const choices = categories
      .filter((category) => !category.isUncategorized)
      .map((category) => ({ id: category.id, slug: category.slug, name: category.name }));
    if (!uncategorized) return { total: 0, rows: [], categories: choices };

    const where = { userId, categoryId: uncategorized.id, ...REAL_MONEY };
    const [total, rows] = await Promise.all([
      tx.notableTransaction.count({ where }),
      tx.notableTransaction.findMany({
        where,
        select: { id: true, occurredAt: true, merchantName: true, description: true, nativeAmount: true, currency: true },
        orderBy: { occurredAt: "desc" },
        take: limit,
      }),
    ]);
    return { total, rows, categories: choices };
  });
}
