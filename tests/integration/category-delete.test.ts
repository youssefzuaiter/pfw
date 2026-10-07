import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { deleteCategoryWithReassignment } from "../../src/server/dal/categories";

/**
 * Deleting a category used to fail on every call: the reassignment step
 * used `notableTransaction.updateMany`, which the field-encryption
 * extension refuses outright (a batch write could persist `description` as
 * plaintext), so the route answered 500 and the screen said "Something went
 * wrong". Nothing exercised this path, so nothing noticed. This suite runs
 * the real DAL against a real Postgres with RLS active.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("deleteCategoryWithReassignment", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let userA: { id: string };
  let userB: { id: string };
  let accountA: { id: string };
  let uncategorizedA: { id: string };
  let uncategorizedB: { id: string };

  beforeAll(async () => {
    admin = createAdminClient();
    const stamp = Date.now();
    userA = await admin.user.create({ data: { email: `cat-delete-a-${stamp}@pfw.local`, displayName: "Cat Delete A" } });
    userB = await admin.user.create({ data: { email: `cat-delete-b-${stamp}@pfw.local`, displayName: "Cat Delete B" } });
    accountA = await admin.bankAccount.create({
      data: { userId: userA.id, institutionName: "Test Bank", last4: "1234", accountType: "CHECKING", nativeBalance: 0n },
    });
    uncategorizedA = await admin.category.create({
      data: { userId: userA.id, slug: "uncategorized", name: "Uncategorized", isUncategorized: true },
    });
    uncategorizedB = await admin.category.create({
      data: { userId: userB.id, slug: "uncategorized", name: "Uncategorized", isUncategorized: true },
    });
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    await admin.$disconnect();
  });

  async function addTransaction(categoryId: string, description: string, deletedAt: Date | null = null) {
    return admin.notableTransaction.create({
      data: {
        userId: userA.id, bankAccountId: accountA.id, categoryId,
        occurredAt: new Date("2026-09-01T00:00:00.000Z"), amount: -10_000n, nativeAmount: -10_000n,
        description, isManual: true, needsReview: false, deletedAt,
      },
    });
  }

  it("moves every transaction, soft-deleted ones included, to Uncategorized and removes the category", async () => {
    const dining = await admin.category.create({ data: { userId: userA.id, slug: "dining", name: "Dining" } });
    const live = await addTransaction(dining.id, "Dinner out");
    const trashed = await addTransaction(dining.id, "Old lunch", new Date("2026-09-02T00:00:00.000Z"));

    const result = await deleteCategoryWithReassignment(userA.id, dining.id);

    expect(result).toEqual({ ok: true, reassignedCount: 2 });
    expect(await admin.category.findUnique({ where: { id: dining.id } })).toBeNull();

    const moved = await admin.notableTransaction.findMany({ where: { id: { in: [live.id, trashed.id] } } });
    expect(moved).toHaveLength(2);
    for (const row of moved) {
      expect(row.categoryId).toBe(uncategorizedA.id);
      expect(row.needsReview).toBe(true);
    }
    // The encrypted description must come through untouched (read back decrypted).
    expect(moved.map((row) => row.description).sort()).toEqual(["Dinner out", "Old lunch"]);
  });

  it("deletes a category that has no transactions, and cascades its envelope allocations", async () => {
    const empty = await admin.category.create({ data: { userId: userA.id, slug: "empty", name: "Empty" } });
    await admin.envelopeAllocation.create({
      data: { userId: userA.id, categoryId: empty.id, amountAgorot: 50_000n, month: "2026-09" },
    });

    expect(await deleteCategoryWithReassignment(userA.id, empty.id)).toEqual({ ok: true, reassignedCount: 0 });
    expect(await admin.category.findUnique({ where: { id: empty.id } })).toBeNull();
    expect(await admin.envelopeAllocation.count({ where: { categoryId: empty.id } })).toBe(0);
  });

  it("refuses the permanent Uncategorized category", async () => {
    expect(await deleteCategoryWithReassignment(userA.id, uncategorizedA.id)).toEqual({ ok: false, error: "is_uncategorized" });
    expect(await admin.category.findUnique({ where: { id: uncategorizedA.id } })).not.toBeNull();
  });

  it("treats another user's category as not found and leaves their data alone", async () => {
    const theirs = await admin.category.create({ data: { userId: userB.id, slug: "travel", name: "Travel" } });
    expect(await deleteCategoryWithReassignment(userA.id, theirs.id)).toEqual({ ok: false, error: "not_found" });
    expect(await admin.category.findUnique({ where: { id: theirs.id } })).not.toBeNull();
    expect(uncategorizedB.id).toBeTruthy();
  });
});
