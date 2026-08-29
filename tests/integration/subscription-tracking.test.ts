import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { getSubscriptionStatuses, setSubscriptionStatus } from "../../src/server/dal/subscriptions";

/**
 * IDOR/RLS coverage for the subscription radar's stateful half
 * (AGENTS.md §3p), same convention as tests/integration/idor.test.ts:
 * User B setting or reading subscription status must never see or
 * affect User A's rows.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("subscription tracking DAL", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let userA: { id: string };
  let userB: { id: string };

  beforeAll(async () => {
    admin = createAdminClient();
    userA = await admin.user.create({
      data: { email: `sub-test-a-${Date.now()}@pfw.local`, displayName: "Sub Test A" },
    });
    userB = await admin.user.create({
      data: { email: `sub-test-b-${Date.now()}@pfw.local`, displayName: "Sub Test B" },
    });
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    await admin.$disconnect();
  });

  it("a merchant with no row is implicitly absent from the status map (defaults to ACTIVE at the call site)", async () => {
    const statuses = await getSubscriptionStatuses(userA.id);
    expect(statuses.has("netflix.com")).toBe(false);
  });

  it("sets and reads back a status for the correct user", async () => {
    await setSubscriptionStatus(userA.id, { merchantKey: "netflix.com", status: "CANCELLED" });
    const statuses = await getSubscriptionStatuses(userA.id);
    expect(statuses.get("netflix.com")).toBe("CANCELLED");
  });

  it("upserts rather than duplicating on a second call for the same merchant", async () => {
    await setSubscriptionStatus(userA.id, { merchantKey: "spotify", status: "ACTIVE" });
    await setSubscriptionStatus(userA.id, { merchantKey: "spotify", status: "REVIEWED" });
    const statuses = await getSubscriptionStatuses(userA.id);
    expect(statuses.get("spotify")).toBe("REVIEWED");

    const rows = await admin.subscriptionTracking.findMany({ where: { userId: userA.id, merchantKey: "spotify" } });
    expect(rows).toHaveLength(1);
  });

  it("User B's status changes never appear in User A's status map (IDOR check)", async () => {
    await setSubscriptionStatus(userB.id, { merchantKey: "netflix.com", status: "REVIEWED" });

    const statusesA = await getSubscriptionStatuses(userA.id);
    const statusesB = await getSubscriptionStatuses(userB.id);

    // Same merchantKey string, two independent users — User A's own
    // "CANCELLED" (set in an earlier test) must be untouched by User B
    // separately setting "REVIEWED" on the same key.
    expect(statusesA.get("netflix.com")).toBe("CANCELLED");
    expect(statusesB.get("netflix.com")).toBe("REVIEWED");
  });
});
