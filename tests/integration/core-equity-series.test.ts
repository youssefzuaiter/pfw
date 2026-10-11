import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CORE_EQUITY_WINDOW_DAYS, listCoreEquitySeries } from "../../src/server/dal/core-mirror";
import { createAdminClient } from "../../src/server/db/admin-client";

/**
 * The core's account-value series against real Postgres with RLS active
 * (AGENTS.md §3hhh). What only a real database can prove: that `DISTINCT ON`
 * keeps the LAST snapshot of each UTC day (not the first, not an average),
 * that midnight UTC is the cut, that the window drops old days, and that
 * another user's snapshots never appear.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("core equity series", () => {
  let admin: ReturnType<typeof createAdminClient>;
  const userIds: string[] = [];

  async function freshUser(): Promise<string> {
    const user = await admin.user.create({
      data: { email: `core-equity-${Date.now()}-${userIds.length}@pfw.local`, displayName: "Core Equity Test" },
    });
    userIds.push(user.id);
    return user.id;
  }

  async function snapshot(userId: string, takenAt: string, equityUsdCents: bigint) {
    await admin.coreSnapshot.create({
      data: { userId, takenAt: new Date(takenAt), equityUsdCents, cashUsdCents: 0n, positions: [], targets: {} },
    });
  }

  beforeAll(() => {
    admin = createAdminClient();
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: { in: userIds } } });
    await admin.$disconnect();
  });

  const NOW = new Date("2026-10-12T12:00:00.000Z");

  it("keeps the last snapshot of each UTC day, oldest day first", async () => {
    const userId = await freshUser();
    // Inserted out of order on purpose: the order is the query's, not the table's.
    await snapshot(userId, "2026-10-06T21:00:00.000Z", 1_020_000n);
    await snapshot(userId, "2026-10-05T09:00:00.000Z", 1_000_000n);
    await snapshot(userId, "2026-10-05T21:00:00.000Z", 1_010_000n);
    await snapshot(userId, "2026-10-06T09:00:00.000Z", 999_999n);

    const series = await listCoreEquitySeries(userId, NOW);
    expect(series.map((p) => [p.takenAt.toISOString(), p.equityUsdCents])).toEqual([
      ["2026-10-05T21:00:00.000Z", 1_010_000],
      ["2026-10-06T21:00:00.000Z", 1_020_000],
    ]);
  });

  it("cuts days at midnight UTC", async () => {
    const userId = await freshUser();
    await snapshot(userId, "2026-10-05T23:59:59.000Z", 1_000_000n);
    await snapshot(userId, "2026-10-06T00:00:00.000Z", 1_050_000n);

    const series = await listCoreEquitySeries(userId, NOW);
    // One second apart, two days: the boundary is the calendar day, not "within 24 hours".
    expect(series.map((p) => p.equityUsdCents)).toEqual([1_000_000, 1_050_000]);
  });

  it("drops days older than the window and keeps the ones inside it", async () => {
    const userId = await freshUser();
    await snapshot(userId, "2026-10-01T21:00:00.000Z", 1_000_000n); // 11 days before NOW
    await snapshot(userId, "2026-10-10T21:00:00.000Z", 1_100_000n); // 2 days before NOW

    const series = await listCoreEquitySeries(userId, NOW, 5);
    expect(series.map((p) => p.equityUsdCents)).toEqual([1_100_000]);
    expect(CORE_EQUITY_WINDOW_DAYS).toBe(400);
  });

  it("returns an empty series for an account with no snapshots", async () => {
    expect(await listCoreEquitySeries(await freshUser(), NOW)).toEqual([]);
  });

  it("never returns another user's snapshots", async () => {
    const mine = await freshUser();
    const theirs = await freshUser();
    await snapshot(mine, "2026-10-05T21:00:00.000Z", 1_000_000n);
    await snapshot(theirs, "2026-10-05T21:00:00.000Z", 7_777_700n);
    await snapshot(theirs, "2026-10-06T21:00:00.000Z", 8_888_800n);

    const series = await listCoreEquitySeries(mine, NOW);
    expect(series.map((p) => p.equityUsdCents)).toEqual([1_000_000]);
  });

  it("carries a large balance through the bigint column without losing a cent", async () => {
    const userId = await freshUser();
    // 90 billion dollars, in cents: well past 32 bits, still an exact JS number.
    await snapshot(userId, "2026-10-05T21:00:00.000Z", 9_000_000_000_001n);

    const series = await listCoreEquitySeries(userId, NOW);
    expect(series[0]?.equityUsdCents).toBe(9_000_000_000_001);
  });
});
