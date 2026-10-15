import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { getNetWorthHistory, recordNetWorthSnapshot, snapshotDayUtc } from "../../src/server/dal/net-worth";

/**
 * The nightly net-worth snapshot's write path against real Postgres with RLS.
 * Only the per-user function runs here, never the all-users job: integration
 * files run in parallel against one shared database, and snapshotting every
 * user would write rows into other suites' fixtures mid-run (the same reason
 * key-rotation.ts's sweep is unit-tested instead). The job's loop and failure
 * handling are covered by src/server/net-worth/snapshot-job.test.ts.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("net-worth snapshots", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let userA: { id: string };
  let userB: { id: string };
  let accountId: string;

  beforeAll(async () => {
    admin = createAdminClient();
    const stamp = Date.now();
    userA = await admin.user.create({ data: { email: `nw-snapshot-a-${stamp}@pfw.local`, displayName: "Snapshot A" } });
    userB = await admin.user.create({ data: { email: `nw-snapshot-b-${stamp}@pfw.local`, displayName: "Snapshot B" } });

    const account = await admin.bankAccount.create({
      data: { userId: userA.id, institutionName: "Test Bank", last4: "4444", accountType: "CHECKING", nativeBalance: 250_000n },
    });
    accountId = account.id;
    await admin.bankAccount.create({
      data: { userId: userA.id, institutionName: "Test Bank", last4: "5555", accountType: "CREDIT_CARD", nativeBalance: 30_000n },
    });
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    await admin.$disconnect();
  });

  it("records today's live figures for the user, on the UTC day", async () => {
    const now = new Date("2026-10-13T23:30:00Z");
    const row = await recordNetWorthSnapshot(userA.id, now);

    expect(row.snapshotDate.toISOString()).toBe("2026-10-13T00:00:00.000Z");
    expect(row.totalAssetsAgorot).toBe(250_000n);
    expect(row.totalLiabilitiesAgorot).toBe(30_000n); // the credit card is a liability, not a negative asset
    expect(row.netWorthAgorot).toBe(220_000n);
  });

  it("replaces the same day's figure on a second run instead of adding a row", async () => {
    await admin.bankAccount.update({ where: { id: accountId }, data: { nativeBalance: 300_000n } });
    await recordNetWorthSnapshot(userA.id, new Date("2026-10-13T23:59:00Z"));

    const rows = await admin.netWorthSnapshot.findMany({ where: { userId: userA.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].netWorthAgorot).toBe(270_000n);
  });

  it("adds a new row on the next day, and the history reads them oldest first", async () => {
    // `getNetWorthHistory` looks back from the real clock, so these rows are
    // dated relative to now, not to the fixed dates above. Those earlier rows
    // are cleared first: once the real clock is within a week of them they
    // would fall inside the 7-day window and appear in the history too.
    await admin.netWorthSnapshot.deleteMany({ where: { userId: userA.id } });
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    await recordNetWorthSnapshot(userA.id, yesterday);
    await recordNetWorthSnapshot(userA.id, today);

    const history = await getNetWorthHistory(userA.id, 7);
    expect(history.map((r) => r.snapshotDate.toISOString())).toEqual([
      snapshotDayUtc(yesterday).toISOString(),
      snapshotDayUtc(today).toISOString(),
    ]);
  });

  it("never shows one user's snapshots to another (RLS)", async () => {
    expect(await getNetWorthHistory(userB.id, 3650)).toEqual([]);
  });
});
