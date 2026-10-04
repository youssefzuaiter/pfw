import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertNativeAmountToAgorot } from "../../src/lib/exchange-rate";
import { nativeAmount } from "../../src/lib/currency";
import { ingestCoreJournal, recordCoreReport } from "../../src/server/dal/core-mirror";
import { getLatestRateTable } from "../../src/server/dal/exchange-rates";
import { MAX_EVENTS_SHOWN, buildCoreAgentData } from "../../src/server/core/build-core-agent-data";
import { createAdminClient } from "../../src/server/db/admin-client";
import type { ReportPayload } from "../../src/server/paper-trader/core-sync-schema";
import { buildChain, initialBuildSpecs, reportPayload } from "./core-sync-fixtures";

/**
 * The view model behind `/trading/core`, against real Postgres: what a
 * mirrored initial build looks like once it has been through the DAL, the
 * pure journal functions and the live exchange rate.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("buildCoreAgentData", () => {
  let admin: ReturnType<typeof createAdminClient>;
  const userIds: string[] = [];

  async function freshUser(): Promise<string> {
    const user = await admin.user.create({
      data: { email: `core-data-${Date.now()}-${userIds.length}@pfw.local`, displayName: "Core Data Test" },
    });
    userIds.push(user.id);
    return user.id;
  }

  beforeAll(() => {
    admin = createAdminClient();
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: { in: userIds } } });
    await admin.$disconnect();
  });

  const chain = buildChain(initialBuildSpecs());
  const report = (over: Parameters<typeof reportPayload>[0] = {}) => reportPayload(over) as unknown as ReportPayload;

  it("is empty for an account the router has never reported to", async () => {
    expect(await buildCoreAgentData(await freshUser())).toEqual({ state: "empty" });
  });

  it("turns a mirrored initial build into plans, events, an account and a verdict on the chain", async () => {
    const userId = await freshUser();
    await ingestCoreJournal(userId, { chainId: chain[0].hash, entries: chain });
    await recordCoreReport(userId, report({ reportedAt: new Date().toISOString() }));

    const data = await buildCoreAgentData(userId);
    if (data.state !== "ready") throw new Error(`expected ready, got ${data.state}`);

    expect(data.integrity).toEqual({ ok: true, entries: 6, head: chain[5].hash });
    expect(data.mirroredEntries).toBe(6);
    expect(data.chainCount).toBe(1);
    expect(data.freshness.state).toBe("fresh");

    expect(data.plans).toHaveLength(1);
    expect(data.plans[0]).toMatchObject({ id: "a1b2c3d4e5f60718", kind: "initial", status: "done", tradedUsdCents: 239_116 });
    expect(data.openPlan).toBeNull();

    expect(data.events[0]).toMatchObject({ index: 5, label: "Plan a1b2c3d4 done", tone: "positive" });
    expect(data.events.at(-1)).toMatchObject({ index: 0, label: "Router started" });
    expect(data.hiddenEventCount).toBe(0);

    const rate = (await getLatestRateTable()).USD;
    if (!data.account) throw new Error("expected an account");
    expect(data.account.usdIlsRate).toBe(rate);
    expect(data.account.equity).toEqual({
      usdCents: 1_000_000,
      ilsAgorot: convertNativeAmountToAgorot(nativeAmount(1_000_000), "USD", rate),
    });
    expect(data.account.cash.usdCents).toBe(100);
    expect(data.account.invested.usdCents).toBe(999_900);
    expect(data.account.dayChange).toMatchObject({ usdCents: 1_000, bps: 10 });
    expect(data.account.cashBps).toBe(1);
    expect(data.account.rows.map((r) => r.symbol)).toEqual(["BND", "IAU", "VNQ", "VTI", "VXUS", "BIL"]);
    expect(data.account.rows.find((r) => r.symbol === "BIL")).toMatchObject({ targetBps: 500, actualBps: 499, driftBps: -1 });
  });

  it("shows a plan that is waiting on the owner as the open one", async () => {
    const userId = await freshUser();
    const waiting = buildChain(initialBuildSpecs().slice(0, 2));
    await ingestCoreJournal(userId, { chainId: waiting[0].hash, entries: waiting });

    const data = await buildCoreAgentData(userId);
    if (data.state !== "ready") throw new Error("expected ready");
    expect(data.openPlan).toMatchObject({ id: "a1b2c3d4e5f60718", status: "awaiting_approval" });
    expect(data.account).toBeNull();
    expect(data.status).toBeNull();
    expect(data.freshness).toEqual({ state: "never", ageSeconds: null });
  });

  it("says so, rather than carrying on, when the stored mirror no longer matches its own hashes", async () => {
    const userId = await freshUser();
    await ingestCoreJournal(userId, { chainId: chain[0].hash, entries: chain });
    // Someone with write access to the database edits an entry (the app's own role cannot; the migrating role can).
    const stored = await admin.coreJournalEntry.findFirstOrThrow({ where: { userId, entryIndex: 2 } });
    await admin.coreJournalEntry.update({ where: { id: stored.id }, data: { rawLine: stored.rawLine.replace("true", "false") } });

    const data = await buildCoreAgentData(userId);
    if (data.state !== "ready") throw new Error("expected ready");
    expect(data.integrity).toMatchObject({ ok: false, atIndex: 2 });
    expect(data.plans.length).toBeGreaterThan(0); // the page still renders what it has
  });

  it(`shows the newest ${MAX_EVENTS_SHOWN} events and counts the rest`, async () => {
    const userId = await freshUser();
    const noisy = buildChain([
      { event: "started" },
      ...Array.from({ length: 49 }, (_, i) => ({ event: "tick_failed", detail: { error: `boom ${i}`, consecutive: i + 3 } })),
    ]);
    await ingestCoreJournal(userId, { chainId: noisy[0].hash, entries: noisy.slice(0, 50) });

    const data = await buildCoreAgentData(userId);
    if (data.state !== "ready") throw new Error("expected ready");
    expect(data.events).toHaveLength(MAX_EVENTS_SHOWN);
    expect(data.hiddenEventCount).toBe(10);
    expect(data.events[0].index).toBe(49);
  });
});
