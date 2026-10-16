import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { needsOnboarding } from "../../src/lib/onboarding";
import { getOnboardingState, markOnboardingComplete, userNeedsOnboarding } from "../../src/server/dal/onboarding";
import { createAdminClient } from "../../src/server/db/admin-client";

/**
 * First-run setup against real Postgres (AGENTS.md §3zzz): who is sent to the
 * wizard, what finishing records, and that it stays per user under RLS.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("onboarding", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let fresh: { id: string };
  let withAccount: { id: string };
  let established: { id: string };
  let other: { id: string };

  beforeAll(async () => {
    admin = createAdminClient();
    const stamp = Date.now();
    const make = (name: string) => admin.user.create({ data: { email: `onboarding-${name}-${stamp}@pfw.local`, displayName: name } });
    [fresh, withAccount, established, other] = await Promise.all([make("fresh"), make("account"), make("established"), make("other")]);

    await admin.bankAccount.create({
      data: { userId: withAccount.id, institutionName: "Bank", last4: "1111", accountType: "CHECKING", nativeBalance: 0n },
    });
    const account = await admin.bankAccount.create({
      data: { userId: established.id, institutionName: "Bank", last4: "2222", accountType: "CHECKING", nativeBalance: 0n },
    });
    const category = await admin.category.create({ data: { userId: established.id, slug: "misc", name: "Misc" } });
    const transaction = (deletedAt: Date | null) =>
      admin.notableTransaction.create({
        data: {
          userId: established.id, bankAccountId: account.id, categoryId: category.id, occurredAt: new Date("2026-09-01T12:00:00Z"),
          currency: "ILS", nativeAmount: -1_000n, amount: -1_000n, description: "Coffee", deletedAt,
        },
      });
    await transaction(null);
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: { in: [fresh.id, withAccount.id, established.id, other.id] } } });
    await admin.$disconnect();
  });

  it("sends a brand-new user to the wizard, without creating a settings row by looking", async () => {
    expect(await userNeedsOnboarding(fresh.id)).toBe(true);
    expect(await getOnboardingState(fresh.id)).toMatchObject({ completedAt: null, accountCount: 0, transactionCount: 0, reportingCurrency: "ILS" });
    expect(await admin.userSettings.count({ where: { userId: fresh.id } })).toBe(0);
  });

  it("keeps sending someone with an account but nothing in it", async () => {
    expect(await getOnboardingState(withAccount.id)).toMatchObject({ accountCount: 1, transactionCount: 0 });
    expect(await userNeedsOnboarding(withAccount.id)).toBe(true);
  });

  it("never sends someone who already uses the app, though they never saw the wizard", async () => {
    expect(await getOnboardingState(established.id)).toMatchObject({ completedAt: null, accountCount: 1, transactionCount: 1 });
    expect(await userNeedsOnboarding(established.id)).toBe(false);
  });

  it("does not count a deleted transaction as something to look at", async () => {
    const account = await admin.bankAccount.findFirstOrThrow({ where: { userId: established.id } });
    const category = await admin.category.findFirstOrThrow({ where: { userId: established.id } });
    const solo = await admin.user.create({ data: { email: `onboarding-solo-${Date.now()}@pfw.local`, displayName: "solo" } });
    try {
      const soloAccount = await admin.bankAccount.create({
        data: { userId: solo.id, institutionName: "Bank", last4: "3333", accountType: "CHECKING", nativeBalance: 0n },
      });
      const soloCategory = await admin.category.create({ data: { userId: solo.id, slug: "misc", name: "Misc" } });
      await admin.notableTransaction.create({
        data: {
          userId: solo.id, bankAccountId: soloAccount.id, categoryId: soloCategory.id, occurredAt: new Date("2026-09-01T12:00:00Z"),
          currency: "ILS", nativeAmount: -1_000n, amount: -1_000n, description: "Deleted", deletedAt: new Date(),
        },
      });
      expect(await getOnboardingState(solo.id)).toMatchObject({ transactionCount: 0 });
      expect(await userNeedsOnboarding(solo.id)).toBe(true);
    } finally {
      await admin.user.delete({ where: { id: solo.id } });
    }
    expect(account.id && category.id).toBeTruthy();
  });

  it("records finishing, keeps the first time on a repeat, and then stops sending them", async () => {
    const first = await markOnboardingComplete(fresh.id);
    const second = await markOnboardingComplete(fresh.id);
    expect(second.getTime()).toBe(first.getTime());

    const state = await getOnboardingState(fresh.id);
    expect(state.completedAt?.getTime()).toBe(first.getTime());
    expect(needsOnboarding(state)).toBe(false);
    expect(await userNeedsOnboarding(fresh.id)).toBe(false);
  });

  it("finishing keeps the other settings, and is per user", async () => {
    await admin.userSettings.upsert({
      where: { userId: other.id },
      create: { userId: other.id, reportingCurrency: "USD" },
      update: { reportingCurrency: "USD" },
    });
    expect((await getOnboardingState(other.id)).reportingCurrency).toBe("USD");
    await markOnboardingComplete(other.id);
    expect(await getOnboardingState(other.id)).toMatchObject({ reportingCurrency: "USD" });
    // Someone else finishing does not finish anyone else's.
    expect((await getOnboardingState(withAccount.id)).completedAt).toBeNull();
  });
});
