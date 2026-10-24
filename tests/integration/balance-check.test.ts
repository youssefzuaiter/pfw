import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteAccount } from "../../src/server/account/delete-account";
import { createAdminClient } from "../../src/server/db/admin-client";
import { checkAccountBalance } from "../../src/server/dal/balance-check";

/**
 * Checking an account against the bank's figure (AGENTS.md §3oooo), against real
 * Postgres: which transactions the app's figure is built from (after the day the
 * entered balance was true for, up to the day checked, transfers in, deleted
 * rows out), the gap and its likely causes, a card's owed balance, another
 * currency, and another user's account never readable. Dates are fixed.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("balance check", () => {
  let admin: ReturnType<typeof createAdminClient>;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const users: string[] = [];
  const at = (iso: string) => new Date(`${iso}T12:00:00Z`);
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
  const NOW = new Date("2026-10-16T09:00:00Z");

  async function seedUser(label: string) {
    const user = await admin.user.create({ data: { email: `balcheck-${label}-${stamp}@pfw.local`, displayName: `Check ${label}` } });
    users.push(user.id);
    const category = await admin.category.create({ data: { userId: user.id, slug: "misc", name: "Misc" } });
    const account = async (
      options: { type?: "CHECKING" | "CREDIT_CARD"; balance?: number; asOf?: string | null; createdAt?: string; nickname?: string } = {},
    ) =>
      (
        await admin.bankAccount.create({
          data: {
            userId: user.id,
            institutionName: "Test Bank",
            nickname: options.nickname ?? "Main",
            last4: "1111",
            accountType: options.type ?? "CHECKING",
            nativeBalance: BigInt(options.balance ?? 1_000_000),
            balanceAsOf: options.asOf === null ? null : day(options.asOf ?? "2026-10-01"),
            createdAt: at(options.createdAt ?? "2026-09-01"),
          },
        })
      ).id;
    const tx = (
      accountId: string,
      iso: string,
      amount: number,
      label: string,
      extra: { isTransfer?: boolean; deleted?: boolean; currency?: "ILS" | "USD"; native?: number } = {},
    ) =>
      admin.notableTransaction.create({
        data: {
          userId: user.id,
          bankAccountId: accountId,
          categoryId: category.id,
          occurredAt: at(iso),
          currency: extra.currency ?? "ILS",
          amount: BigInt(amount),
          nativeAmount: BigInt(extra.native ?? amount),
          description: label,
          merchantName: label,
          isManual: true,
          needsReview: false,
          isTransfer: extra.isTransfer ?? false,
          deletedAt: extra.deleted ? new Date() : null,
        },
      });
    return { id: user.id, account, tx };
  }

  beforeAll(() => {
    admin = createAdminClient();
  });

  afterAll(async () => {
    for (const id of users) await deleteAccount(id);
    await admin.accountDeletionRecord.deleteMany({ where: { deletedUserId: { in: users } } });
  });

  it("matches when the entered balance plus the movement is the bank's figure", async () => {
    const u = await seedUser("match");
    const a = await u.account();
    await u.tx(a, "2026-10-03", -20_000, "Cafe");
    await u.tx(a, "2026-10-05", 5_000, "Refund");
    const out = await checkAccountBalance(u.id, a, { bankNative: 985_000, day: day("2026-10-16"), now: NOW });
    expect(out).toMatchObject({ ok: true, accountLabel: "Main", movementCount: 2, approximate: false });
    if (out.ok) expect(out.result).toMatchObject({ expectedNative: 985_000, gapNative: 0, status: "matches", causes: [] });
  });

  it("builds the figure from the right rows: after the balance day, up to the day checked, transfers in, deleted out", async () => {
    const u = await seedUser("rows");
    const a = await u.account({ asOf: "2026-10-01" });
    await u.tx(a, "2026-09-30", -99_999, "before");
    await u.tx(a, "2026-10-01", -88_888, "on the balance day"); // already in the entered balance
    await u.tx(a, "2026-10-03", -10_000, "counted");
    await u.tx(a, "2026-10-04", -3_000, "transfer out", { isTransfer: true });
    await u.tx(a, "2026-10-05", -7_000, "deleted", { deleted: true });
    await u.tx(a, "2026-10-09", -50_000, "after the day checked");
    const out = await checkAccountBalance(u.id, a, { bankNative: 987_000, day: day("2026-10-08"), now: NOW });
    expect(out).toMatchObject({ ok: true, movementCount: 2 });
    if (out.ok) expect(out.result).toMatchObject({ expectedNative: 987_000, status: "matches" });
    // The end of the day checked is included.
    const edge = await checkAccountBalance(u.id, a, { bankNative: 0, day: day("2026-10-09"), now: NOW });
    if (edge.ok) expect(edge.movementCount).toBe(3);
  });

  it("names a duplicate, with both rows' labels, dates and amounts", async () => {
    const u = await seedUser("dup");
    const a = await u.account();
    await u.tx(a, "2026-10-03", -20_000, "Cafe Roma");
    await u.tx(a, "2026-10-04", -20_000, "Cafe Roma");
    await u.tx(a, "2026-10-05", -5_000, "Bus");
    const out = await checkAccountBalance(u.id, a, { bankNative: 1_000_000 - 25_000, day: day("2026-10-16"), now: NOW });
    expect(out.ok && out.result.status).toBe("bank-higher");
    if (!out.ok) throw new Error("expected ok");
    expect(out.result.gapNative).toBe(20_000);
    expect(out.result.causes[0]).toMatchObject({ kind: "duplicate" });
    expect(out.rows.map((r) => [r.label, r.day, r.deltaNative]).sort()).toEqual([["Cafe Roma", "2026-10-03", -20_000], ["Cafe Roma", "2026-10-04", -20_000]]);
  });

  it("falls back to a missing transaction or a wrong starting balance when nothing explains the gap", async () => {
    const u = await seedUser("missing");
    const a = await u.account();
    await u.tx(a, "2026-10-03", -2_000, "Bus");
    const out = await checkAccountBalance(u.id, a, { bankNative: 900_000, day: day("2026-10-16"), now: NOW });
    if (!out.ok) throw new Error("expected ok");
    expect(out.result.status).toBe("bank-lower");
    expect(out.result.causes).toEqual([{ kind: "missing-or-start" }]);
    expect(out.rows).toEqual([]);
  });

  it("treats a card's balance as money owed", async () => {
    const u = await seedUser("card");
    const a = await u.account({ type: "CREDIT_CARD", balance: 50_000 });
    await u.tx(a, "2026-10-03", -8_000, "Charge");
    await u.tx(a, "2026-10-04", 20_000, "Payment");
    const out = await checkAccountBalance(u.id, a, { bankNative: 38_000, day: day("2026-10-16"), now: NOW });
    expect(out.ok && out.result.status).toBe("matches");
  });

  it("uses the creation moment when the balance has no day, and marks another currency as approximate", async () => {
    const u = await seedUser("nodate");
    const a = await u.account({ asOf: null, createdAt: "2026-10-02" });
    await u.tx(a, "2026-10-01", -77_777, "before it was added");
    await u.tx(a, "2026-10-03", -10_000, "after");
    await u.tx(a, "2026-10-04", -3_700, "Dollar thing", { currency: "USD", native: -1_000 });
    const out = await checkAccountBalance(u.id, a, { bankNative: 0, day: day("2026-10-16"), now: NOW });
    if (!out.ok) throw new Error("expected ok");
    expect(out.movementCount).toBe(2);
    expect(out.approximate).toBe(true);
    expect(out.typedAsOf).toBeNull();
    // The ILS row counts at its own amount: 1,000,000 - 10,000 - 3,700.
    expect(out.result.expectedNative).toBe(986_300);
  });

  it("refuses a day before the entered balance, or in the future", async () => {
    const u = await seedUser("days");
    const a = await u.account({ asOf: "2026-10-01" });
    expect(await checkAccountBalance(u.id, a, { bankNative: 1, day: day("2026-09-30"), now: NOW })).toEqual({ ok: false, error: "before_balance_date", earliest: "2026-10-01" });
    expect(await checkAccountBalance(u.id, a, { bankNative: 1, day: day("2026-10-01"), now: NOW })).toMatchObject({ ok: true });
    expect(await checkAccountBalance(u.id, a, { bankNative: 1, day: day("2026-10-17"), now: NOW })).toEqual({ ok: false, error: "in_future" });
    expect(await checkAccountBalance(u.id, a, { bankNative: 1, day: day("2026-10-16"), now: NOW })).toMatchObject({ ok: true });
  });

  it("does not read another user's account", async () => {
    const owner = await seedUser("owner");
    const a = await owner.account();
    const stranger = await seedUser("stranger");
    expect(await checkAccountBalance(stranger.id, a, { bankNative: 1, day: day("2026-10-16"), now: NOW })).toEqual({ ok: false, error: "not_found" });
    expect(await checkAccountBalance(owner.id, "nonexistent", { bankNative: 1, day: day("2026-10-16"), now: NOW })).toEqual({ ok: false, error: "not_found" });
  });
});
