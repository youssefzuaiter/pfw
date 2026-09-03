import "server-only";
import { withUserScope } from "../db/with-user-scope";

/** Active (non-archived) categories — what every other screen's filters/selects use. */
export async function listCategories(userId: string) {
  return withUserScope(userId, (tx) =>
    tx.category.findMany({ where: { userId, archivedAt: null }, orderBy: { name: "asc" } }),
  );
}

/** Includes archived categories — the /categories management screen needs to show what's archived too. */
export async function listAllCategories(userId: string) {
  return withUserScope(userId, (tx) => tx.category.findMany({ where: { userId }, orderBy: { name: "asc" } }));
}

/** See bank-accounts.ts for why this returns `null` rather than throwing on a mismatch. */
export async function getCategoryById(userId: string, id: string) {
  return withUserScope(userId, (tx) => tx.category.findFirst({ where: { id, userId } }));
}

/** Every user has exactly one of these (schema.prisma's Category model) — created by the seed script for the demo user. */
export async function getUncategorizedCategory(userId: string) {
  return withUserScope(userId, (tx) => tx.category.findFirstOrThrow({ where: { userId, isUncategorized: true } }));
}

export type CreateCategoryResult = { ok: true; category: Awaited<ReturnType<typeof getCategoryById>> } | { ok: false; error: "slug_taken" };

/** Slugs are permanent (the "permanent category slugs" law) — the caller supplies one at creation and it never changes again, even across a rename. */
export async function createCategory(userId: string, input: { slug: string; name: string }): Promise<CreateCategoryResult> {
  return withUserScope(userId, async (tx) => {
    const existing = await tx.category.findFirst({ where: { userId, slug: input.slug } });
    if (existing) return { ok: false, error: "slug_taken" };

    const category = await tx.category.create({ data: { userId, slug: input.slug, name: input.name } });
    return { ok: true, category };
  });
}

/** Renames change `name` only — `slug` is permanent, so links/rules keyed on it survive a rename. */
export async function renameCategory(userId: string, id: string, name: string) {
  return withUserScope(userId, async (tx) => {
    const existing = await tx.category.findFirst({ where: { id, userId } });
    if (!existing) return null;
    return tx.category.update({ where: { id }, data: { name } });
  });
}

export async function archiveCategory(userId: string, id: string) {
  return withUserScope(userId, async (tx) => {
    const existing = await tx.category.findFirst({ where: { id, userId } });
    if (!existing || existing.isUncategorized) return null;
    return tx.category.update({ where: { id }, data: { archivedAt: new Date() } });
  });
}

export async function unarchiveCategory(userId: string, id: string) {
  return withUserScope(userId, async (tx) => {
    const existing = await tx.category.findFirst({ where: { id, userId } });
    if (!existing) return null;
    return tx.category.update({ where: { id }, data: { archivedAt: null } });
  });
}

export type DeleteCategoryResult = { ok: true; reassignedCount: number } | { ok: false; error: "not_found" | "is_uncategorized" };

/**
 * Safe-delete: every transaction in this category is reassigned to the
 * user's permanent Uncategorized category (and flagged for review, since
 * their categorization is no longer what the user chose) *before* the
 * category row is deleted. The DB enforces this ordering independently —
 * NotableTransaction.category has no cascade, so a skipped reassignment
 * step would fail loudly (a foreign key violation) rather than silently
 * orphaning transactions.
 */
export async function deleteCategoryWithReassignment(userId: string, id: string): Promise<DeleteCategoryResult> {
  return withUserScope(userId, async (tx) => {
    const existing = await tx.category.findFirst({ where: { id, userId } });
    if (!existing) return { ok: false, error: "not_found" };
    if (existing.isUncategorized) return { ok: false, error: "is_uncategorized" };

    const uncategorized = await tx.category.findFirstOrThrow({ where: { userId, isUncategorized: true } });

    const { count } = await tx.notableTransaction.updateMany({
      where: { userId, categoryId: id },
      data: { categoryId: uncategorized.id, needsReview: true },
    });

    // EnvelopeAllocation rows cascade-delete automatically (schema.prisma's onDelete: Cascade).
    await tx.category.delete({ where: { id } });

    return { ok: true, reassignedCount: count };
  });
}
