import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import {
  disablePhoneAlerts,
  enablePhoneAlerts,
  gatherPhoneAlertFacts,
  getPhoneAlertDelivery,
  getPhoneAlertSettings,
  savePhoneAlertState,
  updatePhoneAlertPreferences,
} from "../../src/server/dal/phone-alerts";

/**
 * Phone alerts' database half against real Postgres with RLS (AGENTS.md
 * §3qqq): the topic is ciphertext at rest and only its ending ever reaches a
 * page, another user can neither see nor change a subscription, and the facts
 * the nightly check decides on are exactly the new, real, large expenses, the
 * new notifications, the budgeted envelopes that are overdrawn, and the last
 * import. Only the per-user functions run here; the all-users job is
 * unit-tested (src/server/alerts/phone-alerts-job.test.ts), for the same
 * reason the net-worth snapshot job is.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("phone alerts", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let userA: { id: string };
  let userB: { id: string };
  let accountId: string;
  let groceriesId: string;
  let diningId: string;
  let uncategorizedId: string;

  const TOPIC = "pfw-integration-topic-a1b2";
  const SINCE = new Date("2026-10-12T00:00:00Z");
  const NOW = new Date("2026-10-13T00:00:00Z");

  beforeAll(async () => {
    admin = createAdminClient();
    const stamp = Date.now();
    userA = await admin.user.create({ data: { email: `phone-alerts-a-${stamp}@pfw.local`, displayName: "Alerts A" } });
    userB = await admin.user.create({ data: { email: `phone-alerts-b-${stamp}@pfw.local`, displayName: "Alerts B" } });

    const account = await admin.bankAccount.create({
      data: { userId: userA.id, institutionName: "Test Bank", last4: "1234", accountType: "CHECKING", nativeBalance: 0n },
    });
    accountId = account.id;
    uncategorizedId = (await admin.category.create({ data: { userId: userA.id, slug: "uncategorized", name: "Uncategorized", isUncategorized: true } })).id;
    groceriesId = (await admin.category.create({ data: { userId: userA.id, slug: "groceries", name: "Groceries" } })).id;
    diningId = (await admin.category.create({ data: { userId: userA.id, slug: "dining", name: "Dining" } })).id;

    // Groceries was budgeted ₪100 and has spent ₪150: overdrawn. Dining was
    // never budgeted and has spent too: negative, but not an envelope in use.
    await admin.envelopeAllocation.create({
      data: { userId: userA.id, categoryId: groceriesId, month: "2026-10", amountAgorot: 10_000n },
    });

    async function tx(fields: { categoryId?: string; amount: bigint; createdAt: Date; description: string; extra?: object }) {
      await admin.notableTransaction.create({
        data: {
          userId: userA.id,
          bankAccountId: accountId,
          categoryId: fields.categoryId ?? uncategorizedId,
          occurredAt: new Date("2026-10-05T10:00:00Z"),
          amount: fields.amount,
          nativeAmount: fields.amount,
          description: fields.description,
          merchantName: fields.description.toUpperCase(),
          isManual: false,
          needsReview: false,
          createdAt: fields.createdAt,
          ...fields.extra,
        },
      });
    }
    const inWindow = new Date("2026-10-12T20:00:00Z");
    await tx({ categoryId: groceriesId, amount: -15_000n, createdAt: inWindow, description: "market" });
    await tx({ categoryId: diningId, amount: -2_000n, createdAt: inWindow, description: "cafe" });
    await tx({ amount: -300_000n, createdAt: inWindow, description: "rent" });
    await tx({ amount: -150_000n, createdAt: inWindow, description: "laptop" });
    await tx({ amount: -900_000n, createdAt: inWindow, description: "own transfer", extra: { isTransfer: true } });
    await tx({ amount: -800_000n, createdAt: inWindow, description: "deleted", extra: { deletedAt: new Date() } });
    await tx({ amount: -700_000n, createdAt: new Date("2026-10-11T23:00:00Z"), description: "before window" });
    await tx({ amount: -600_000n, createdAt: new Date("2026-10-13T00:00:01Z"), description: "after window" });
    await tx({
      amount: -100n,
      createdAt: new Date("2026-09-01T09:00:00Z"),
      description: "imported",
      extra: { providerTransactionId: "csv:generic:hash:abc" },
    });

    await admin.notification.create({
      data: { userId: userA.id, type: "dead_mans_switch_grace_period", message: "Vault grace period", createdAt: inWindow },
    });
    await admin.notification.create({
      data: { userId: userA.id, type: "dead_mans_switch_grace_period", message: "Old notice", createdAt: new Date("2026-10-01T00:00:00Z") },
    });
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    await admin.$disconnect();
  });

  it("stores the topic as ciphertext and shows a page only its ending", async () => {
    const settings = await enablePhoneAlerts(userA.id, TOPIC);
    expect(settings).toEqual({ topicHint: "…a1b2", largeExpenseAgorot: 100_000, includeDetails: true });

    const [raw] = await admin.$queryRaw<{ topic: string }[]>`SELECT "topic" FROM "PhoneAlertSubscription" WHERE "userId" = ${userA.id}`;
    expect(raw.topic).toMatch(/^v[12]:/);
    expect(raw.topic).not.toContain(TOPIC);

    expect(await getPhoneAlertSettings(userA.id)).toEqual(settings);
    expect((await getPhoneAlertDelivery(userA.id))?.topic).toBe(TOPIC);
  });

  it("never lets another user see, change or remove the subscription (RLS)", async () => {
    expect(await getPhoneAlertSettings(userB.id)).toBeNull();
    expect(await getPhoneAlertDelivery(userB.id)).toBeNull();
    expect(await updatePhoneAlertPreferences(userB.id, { includeDetails: false })).toBeNull();
    expect(await disablePhoneAlerts(userB.id)).toBe(false);
    expect((await getPhoneAlertSettings(userA.id))?.includeDetails).toBe(true);
  });

  it("updates the threshold and details switch", async () => {
    const updated = await updatePhoneAlertPreferences(userA.id, { largeExpenseAgorot: 100_000, includeDetails: false });
    expect(updated).toEqual({ topicHint: "…a1b2", largeExpenseAgorot: 100_000, includeDetails: false });
  });

  it("gathers only new, real, large expenses, new notifications, budgeted overdrawn envelopes and the last import", async () => {
    const facts = await gatherPhoneAlertFacts(userA.id, { since: SINCE, now: NOW, largeExpenseAgorot: 100_000 });

    expect(facts.largeExpenses.map((e) => e.label)).toEqual(["RENT", "LAPTOP"]);
    expect(facts.largeExpenses[0]).toEqual({ label: "RENT", amount: "-₪3,000.00", day: "2026-10-05" });
    expect(facts.largeExpenseCount).toBe(2);
    expect(facts.notifications).toEqual(["Vault grace period"]);
    expect(facts.overdrawn).toEqual([{ categoryId: groceriesId, name: "Groceries", balance: "-₪50.00" }]);
    expect(facts.lastImportAt?.toISOString()).toBe("2026-09-01T09:00:00.000Z");
  });

  it("finds nothing new on the first check, when there is no starting point", async () => {
    const facts = await gatherPhoneAlertFacts(userA.id, { since: null, now: NOW, largeExpenseAgorot: 100_000 });
    expect(facts.largeExpenses).toEqual([]);
    expect(facts.largeExpenseCount).toBe(0);
    expect(facts.notifications).toEqual([]);
    expect(facts.overdrawn.map((e) => e.categoryId)).toEqual([groceriesId]);
  });

  it("gathers nothing of another user's", async () => {
    const facts = await gatherPhoneAlertFacts(userB.id, { since: SINCE, now: NOW, largeExpenseAgorot: 1 });
    expect(facts).toMatchObject({ largeExpenses: [], largeExpenseCount: 0, notifications: [], overdrawn: [], lastImportAt: null });
  });

  it("saves where the check left off, and turning alerts off removes everything", async () => {
    await savePhoneAlertState(userA.id, { lastCheckedAt: NOW, overdrawnCategoryIds: [groceriesId], importReminderSentAt: NOW, remindedBillKeys: ["manual:abc|2026-10-14"] });
    expect((await getPhoneAlertDelivery(userA.id))?.state).toEqual({
      lastCheckedAt: NOW,
      overdrawnCategoryIds: [groceriesId],
      importReminderSentAt: NOW,
      remindedBillKeys: ["manual:abc|2026-10-14"],
    });

    expect(await disablePhoneAlerts(userA.id)).toBe(true);
    expect(await getPhoneAlertDelivery(userA.id)).toBeNull();
    expect(await admin.phoneAlertSubscription.count({ where: { userId: userA.id } })).toBe(0);
  });
});
