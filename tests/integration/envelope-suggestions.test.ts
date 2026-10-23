import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteAccount } from "../../src/server/account/delete-account";
import { createAdminClient } from "../../src/server/db/admin-client";
import { agorot } from "../../src/lib/money";
import { applyEnvelopeSuggestions, listEnvelopeSuggestions, MAX_SUGGESTION_ITEMS } from "../../src/server/dal/envelope-suggestions";

/**
 * Suggested envelope amounts (AGENTS.md §3mmmm), against real Postgres: what is
 * suggested from the previous months (transfers, deleted rows and income left
 * out, months with no activity not counted), which envelopes are offered, and
 * that applying is all or nothing, never overwrites a budget, respects what is
 * available, and cannot touch another user's categories.
 *
 * Budgeting October 2026; the three months before it are July to September.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("envelope suggestions", () => {
  let admin: ReturnType<typeof createAdminClient>;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const users: string[] = [];
  const MONTH = "2026-10";

  async function seedUser(label: string) {
    const user = await admin.user.create({ data: { email: `suggest-${label}-${stamp}@pfw.local`, displayName: `Suggest ${label}` } });
    users.push(user.id);
    const account = await admin.bankAccount.create({ data: { userId: user.id, institutionName: "Test Bank", last4: "1111", accountType: "CHECKING", nativeBalance: 0n } });
    const category = async (slug: string, extra: { archived?: boolean } = {}) =>
      (await admin.category.create({ data: { userId: user.id, slug, name: slug, archivedAt: extra.archived ? new Date() : null } })).id;
    const tx = (categoryId: string, iso: string, amount: number, extra: { isTransfer?: boolean; deleted?: boolean } = {}) =>
      admin.notableTransaction.create({
        data: {
          userId: user.id,
          bankAccountId: account.id,
          categoryId,
          occurredAt: new Date(`${iso}T12:00:00Z`),
          amount: BigInt(amount),
          nativeAmount: BigInt(amount),
          description: "row",
          merchantName: "row",
          isManual: true,
          needsReview: false,
          isTransfer: extra.isTransfer ?? false,
          deletedAt: extra.deleted ? new Date() : null,
        },
      });
    const allocate = (categoryId: string, amount: number, month = MONTH) =>
      admin.envelopeAllocation.create({ data: { userId: user.id, categoryId, month, amountAgorot: BigInt(amount) } });
    return { id: user.id, category, tx, allocate };
  }

  beforeAll(() => {
    admin = createAdminClient();
  });

  afterAll(async () => {
    for (const id of users) await deleteAccount(id);
    await admin.accountDeletionRecord.deleteMany({ where: { deletedUserId: { in: users } } });
  });

  it("suggests the average of the previous months, rounded up to the next ten shekels", async () => {
    const u = await seedUser("basic");
    const groceries = await u.category("groceries");
    const dining = await u.category("dining");
    for (const [iso, amount] of [["2026-07-10", 150_000], ["2026-08-10", 162_000], ["2026-09-10", 171_000]] as const) await u.tx(groceries, iso, -amount);
    for (const iso of ["2026-07-12", "2026-08-12", "2026-09-12"]) await u.tx(dining, iso, -100_500);
    await u.tx(groceries, "2026-09-01", 500_000); // income: not spending

    const result = await listEnvelopeSuggestions(u.id, MONTH);
    expect(result.monthsUsed).toBe(3);
    const byName = Object.fromEntries(result.suggestions.map((s) => [s.categoryName, s]));
    expect(byName.groceries).toMatchObject({ averageAgorot: 161_000, suggestedAgorot: 161_000 });
    expect(byName.dining).toMatchObject({ averageAgorot: 100_500, suggestedAgorot: 101_000 });
    expect(result.suggestions[0].categoryName).toBe("groceries");
    expect(Number(result.availableAgorot)).toBe(500_000);
  });

  it("does not count a month with no activity as zero spending", async () => {
    const u = await seedUser("gap");
    const groceries = await u.category("groceries");
    await u.tx(groceries, "2026-08-10", -100_000);
    await u.tx(groceries, "2026-09-10", -200_000);
    const result = await listEnvelopeSuggestions(u.id, MONTH);
    expect(result.monthsUsed).toBe(2);
    expect(result.suggestions[0].averageAgorot).toBe(150_000);
  });

  it("leaves out transfers, deleted rows, the current month and older months", async () => {
    const u = await seedUser("excluded");
    const groceries = await u.category("groceries");
    await u.tx(groceries, "2026-09-10", -100_000);
    await u.tx(groceries, "2026-09-11", -900_000, { isTransfer: true });
    await u.tx(groceries, "2026-09-12", -900_000, { deleted: true });
    await u.tx(groceries, "2026-10-05", -900_000); // the month being budgeted
    await u.tx(groceries, "2026-06-20", -900_000); // before the three months
    const result = await listEnvelopeSuggestions(u.id, MONTH);
    expect(result.monthsUsed).toBe(1);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].averageAgorot).toBe(100_000);
  });

  it("only offers envelopes with nothing set for the month", async () => {
    const u = await seedUser("open");
    const set = await u.category("set");
    const zero = await u.category("zero");
    const open = await u.category("open");
    for (const id of [set, zero, open]) await u.tx(id, "2026-09-10", -50_000);
    await u.allocate(set, 20_000);
    await u.allocate(zero, 0);
    const names = (await listEnvelopeSuggestions(u.id, MONTH)).suggestions.map((s) => s.categoryName).sort();
    expect(names).toEqual(["open", "zero"]);
  });

  it("suggests nothing without history, and shows another user none of it", async () => {
    const empty = await seedUser("empty");
    await empty.category("groceries");
    expect(await listEnvelopeSuggestions(empty.id, MONTH)).toMatchObject({ monthsUsed: 0, suggestions: [] });

    const owner = await seedUser("owner");
    await owner.tx(await owner.category("groceries"), "2026-09-10", -50_000);
    const stranger = await seedUser("stranger");
    expect((await listEnvelopeSuggestions(stranger.id, MONTH)).suggestions).toEqual([]);
  });

  describe("applying", () => {
    async function withIncome(label: string, income: number) {
      const u = await seedUser(label);
      const a = await u.category("a");
      const b = await u.category("b");
      await u.tx(a, "2026-09-02", income);
      return { ...u, a, b };
    }
    const rows = (db: ReturnType<typeof createAdminClient>, userId: string) =>
      db.envelopeAllocation.findMany({ where: { userId, month: MONTH }, orderBy: { categoryId: "asc" } });

    it("sets the chosen envelopes, all at once", async () => {
      const u = await withIncome("apply", 500_000);
      const result = await applyEnvelopeSuggestions(u.id, MONTH, [
        { categoryId: u.a, amountAgorot: agorot(120_000) },
        { categoryId: u.b, amountAgorot: agorot(80_000) },
      ]);
      expect(result).toMatchObject({ ok: true, applied: 2, totalAgorot: 200_000 });
      const stored = await rows(admin, u.id);
      expect(stored.map((r) => Number(r.amountAgorot)).sort((x, y) => x - y)).toEqual([80_000, 120_000]);
    });

    it("refuses a total above what is available, and writes nothing", async () => {
      const u = await withIncome("over", 100_000);
      const result = await applyEnvelopeSuggestions(u.id, MONTH, [
        { categoryId: u.a, amountAgorot: agorot(60_000) },
        { categoryId: u.b, amountAgorot: agorot(60_000) },
      ]);
      expect(result).toMatchObject({ ok: false, error: "exceeds_available", requestedAgorot: 120_000 });
      expect(await rows(admin, u.id)).toEqual([]);
      // Exactly what is available is fine.
      expect(await applyEnvelopeSuggestions(u.id, MONTH, [{ categoryId: u.a, amountAgorot: agorot(100_000) }])).toMatchObject({ ok: true });
    });

    it("never overwrites a budget already set, and writes nothing when one is", async () => {
      const u = await withIncome("already", 500_000);
      await u.allocate(u.a, 30_000);
      const result = await applyEnvelopeSuggestions(u.id, MONTH, [
        { categoryId: u.a, amountAgorot: agorot(90_000) },
        { categoryId: u.b, amountAgorot: agorot(10_000) },
      ]);
      expect(result).toMatchObject({ ok: false, error: "already_set" });
      const stored = await rows(admin, u.id);
      expect(stored).toHaveLength(1);
      expect(Number(stored[0].amountAgorot)).toBe(30_000);
    });

    it("refuses another user's category, an archived one and the uncategorized one, all or nothing", async () => {
      const u = await withIncome("scope", 500_000);
      const other = await seedUser("other");
      const theirs = await other.category("theirs");
      const archived = await u.category("archived", { archived: true });
      const uncategorized = (await admin.category.create({ data: { userId: u.id, slug: "uncategorized", name: "Uncategorized", isUncategorized: true } })).id;

      for (const bad of [theirs, archived, uncategorized]) {
        const result = await applyEnvelopeSuggestions(u.id, MONTH, [
          { categoryId: u.a, amountAgorot: agorot(10_000) },
          { categoryId: bad, amountAgorot: agorot(10_000) },
        ]);
        expect(result).toMatchObject({ ok: false, error: "category_not_found" });
      }
      expect(await rows(admin, u.id)).toEqual([]);
      expect(await rows(admin, other.id)).toEqual([]);
    });

    it("refuses an empty or oversized request and a repeated category", async () => {
      const u = await withIncome("limits", 500_000);
      await expect(applyEnvelopeSuggestions(u.id, MONTH, [])).rejects.toThrow(RangeError);
      const many = Array.from({ length: MAX_SUGGESTION_ITEMS + 1 }, (_, i) => ({ categoryId: `c${i}`, amountAgorot: agorot(100) }));
      await expect(applyEnvelopeSuggestions(u.id, MONTH, many)).rejects.toThrow(RangeError);
      await expect(
        applyEnvelopeSuggestions(u.id, MONTH, [
          { categoryId: u.a, amountAgorot: agorot(100) },
          { categoryId: u.a, amountAgorot: agorot(100) },
        ]),
      ).rejects.toThrow(RangeError);
    });
  });
});
