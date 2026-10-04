import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex, verifyJournalChain } from "../../src/lib/core-journal";
import { getCoreMirror, ingestCoreJournal, recordCoreReport } from "../../src/server/dal/core-mirror";
import { createAdminClient } from "../../src/server/db/admin-client";
import { withUserScope } from "../../src/server/db/with-user-scope";
import type { ReportPayload } from "../../src/server/paper-trader/core-sync-schema";
import { buildChain, initialBuildSpecs, reportPayload } from "./core-sync-fixtures";

/**
 * The long-term core's mirror against real Postgres with RLS active
 * (AGENTS.md §3fff): ingest semantics (append, duplicate, gap, conflict,
 * invalid), concurrency, per-user isolation, the app role's inability to
 * rewrite a journal entry, and the report/snapshot path. The pure rules
 * are unit-tested in `src/lib/core-journal.test.ts`; what only a real
 * database can prove — `ON CONFLICT DO NOTHING` under a race, a REVOKE
 * that actually denies, a policy that actually filters — is here.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("core mirror DAL", () => {
  let admin: ReturnType<typeof createAdminClient>;
  const userIds: string[] = [];

  async function freshUser(): Promise<string> {
    const user = await admin.user.create({
      data: { email: `core-mirror-${Date.now()}-${userIds.length}@pfw.local`, displayName: "Core Mirror Test" },
    });
    userIds.push(user.id);
    return user.id;
  }

  beforeAll(() => {
    admin = createAdminClient();
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: { in: userIds } } }); // cascades to the three mirror tables
    await admin.$disconnect();
  });

  const chain = buildChain(initialBuildSpecs());
  const chainId = chain[0].hash;

  describe("ingestCoreJournal", () => {
    it("stores a whole new chain and derives the columns from each line", async () => {
      const userId = await freshUser();
      const result = await ingestCoreJournal(userId, { chainId, entries: chain });
      expect(result).toEqual({ status: "recorded", accepted: 6, duplicates: 0, nextIndex: 6 });

      const rows = await admin.coreJournalEntry.findMany({ where: { userId }, orderBy: { entryIndex: "asc" } });
      expect(rows.map((r) => r.event)).toEqual([
        "started",
        "plan_accepted",
        "plan_approved",
        "order_submitted",
        "order_submitted",
        "plan_done",
      ]);
      expect(rows[1].planId).toBe("a1b2c3d4e5f60718");
      expect(rows[0].planId).toBeNull();
      expect(rows[0].occurredAt.toISOString()).toBe("2026-10-05T13:00:00.000Z");
      expect(rows[3].entryHash).toBe(chain[3].hash);
      expect(rows[3].rawLine).toBe(chain[3].raw);
      expect(rows.every((r) => r.chainId === chainId)).toBe(true);
    });

    it("reports a replayed batch as a duplicate and stores nothing twice", async () => {
      const userId = await freshUser();
      await ingestCoreJournal(userId, { chainId, entries: chain });
      expect(await ingestCoreJournal(userId, { chainId, entries: chain })).toEqual({
        status: "duplicate",
        accepted: 0,
        duplicates: 6,
        nextIndex: 6,
      });
      expect(await admin.coreJournalEntry.count({ where: { userId } })).toBe(6);
    });

    it("accepts a chain in pieces, and what comes back is one whole, verifiable chain", async () => {
      const userId = await freshUser();
      expect(await ingestCoreJournal(userId, { chainId, entries: chain.slice(0, 3) })).toMatchObject({ status: "recorded", nextIndex: 3 });
      expect(await ingestCoreJournal(userId, { chainId, entries: chain.slice(3) })).toMatchObject({ status: "recorded", nextIndex: 6 });

      const mirror = await getCoreMirror(userId);
      if (!mirror.available) throw new Error("expected the mirror to be available");
      expect(verifyJournalChain(mirror.entries)).toEqual({ ok: true, entries: 6, head: chain[5].hash });
    });

    it("stores only the part of an overlapping batch it did not have", async () => {
      const userId = await freshUser();
      await ingestCoreJournal(userId, { chainId, entries: chain.slice(0, 4) });
      expect(await ingestCoreJournal(userId, { chainId, entries: chain.slice(2) })).toEqual({
        status: "recorded",
        accepted: 2,
        duplicates: 2,
        nextIndex: 6,
      });
      expect(await admin.coreJournalEntry.count({ where: { userId } })).toBe(6);
    });

    it("answers a batch that starts beyond what it holds with where it actually is, and stores nothing", async () => {
      const userId = await freshUser();
      await ingestCoreJournal(userId, { chainId, entries: chain.slice(0, 3) });
      expect(await ingestCoreJournal(userId, { chainId, entries: chain.slice(5) })).toEqual({ status: "gap", nextIndex: 3 });
      expect(await admin.coreJournalEntry.count({ where: { userId } })).toBe(3);
    });

    it("refuses to hold two versions of one entry", async () => {
      const userId = await freshUser();
      await ingestCoreJournal(userId, { chainId, entries: chain });
      // Same first three entries (so the same chain id), then a different history.
      const forked = buildChain([...initialBuildSpecs().slice(0, 3), { event: "plan_expired", detail: { plan_id: "a1b2c3d4e5f60718", kind: "initial", reason: "forked", orders: {} } }]);
      expect(forked[0].hash).toBe(chainId);
      const result = await ingestCoreJournal(userId, { chainId, entries: forked.slice(2) });
      expect(result).toMatchObject({ status: "conflict", index: 3 });
      expect(await admin.coreJournalEntry.count({ where: { userId } })).toBe(6);
    });

    it("rejects a batch that is not internally sound, storing nothing", async () => {
      const userId = await freshUser();
      const tampered = chain.map((e) => ({ ...e }));
      tampered[2].raw = tampered[2].raw.replace("true", "false");
      const result = await ingestCoreJournal(userId, { chainId, entries: tampered });
      expect(result).toMatchObject({ status: "invalid" });
      expect(await admin.coreJournalEntry.count({ where: { userId } })).toBe(0);
    });

    it("rejects a chain whose first entry is not the chain's own id", async () => {
      const userId = await freshUser();
      expect(await ingestCoreJournal(userId, { chainId: sha256Hex("something else"), entries: chain })).toMatchObject({ status: "invalid" });
    });

    it("survives two identical batches arriving at the same moment", async () => {
      const userId = await freshUser();
      const results = await Promise.all([
        ingestCoreJournal(userId, { chainId, entries: chain }),
        ingestCoreJournal(userId, { chainId, entries: chain }),
      ]);
      expect(results.every((r) => r.status === "recorded" || r.status === "duplicate")).toBe(true);
      expect(await admin.coreJournalEntry.count({ where: { userId } })).toBe(6);
    });
  });

  describe("per-user isolation and immutability", () => {
    it("never shows one user's mirror to another", async () => {
      const owner = await freshUser();
      const stranger = await freshUser();
      await ingestCoreJournal(owner, { chainId, entries: chain });
      await recordCoreReport(owner, reportPayload() as unknown as ReportPayload);

      expect(await getCoreMirror(stranger)).toEqual({
        available: true,
        status: null,
        snapshot: null,
        entries: [],
        chainId: null,
        chainCount: 0,
      });
    });

    it("lets the same journal be mirrored for two users without either clobbering the other", async () => {
      const a = await freshUser();
      const b = await freshUser();
      await ingestCoreJournal(a, { chainId, entries: chain });
      expect(await ingestCoreJournal(b, { chainId, entries: chain })).toMatchObject({ status: "recorded", accepted: 6 });
    });

    it("refuses a write on behalf of another user (row-level security)", async () => {
      const a = await freshUser();
      const b = await freshUser();
      await expect(
        withUserScope(b, (tx) =>
          tx.coreJournalEntry.create({
            data: {
              userId: a,
              chainId,
              entryIndex: 0,
              entryHash: chain[0].hash,
              prevHash: "",
              event: "started",
              occurredAt: new Date(),
              rawLine: chain[0].raw,
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it("gives the app's own role no way to rewrite or delete a mirrored entry", async () => {
      const userId = await freshUser();
      await ingestCoreJournal(userId, { chainId, entries: chain });

      await expect(
        withUserScope(userId, (tx) => tx.$executeRaw`UPDATE "CoreJournalEntry" SET "event" = 'forged' WHERE "userId" = ${userId}`),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        withUserScope(userId, (tx) => tx.$executeRaw`DELETE FROM "CoreJournalEntry" WHERE "userId" = ${userId}`),
      ).rejects.toThrow(/permission denied/i);

      expect(await admin.coreJournalEntry.count({ where: { userId, event: "forged" } })).toBe(0);
      expect(await admin.coreJournalEntry.count({ where: { userId } })).toBe(6);
    });
  });

  describe("recordCoreReport", () => {
    const report = (over: Parameters<typeof reportPayload>[0] = {}) => reportPayload(over) as unknown as ReportPayload;

    it("stores the router's status and its account, and reads them back as plain numbers", async () => {
      const userId = await freshUser();
      const result = await recordCoreReport(
        userId,
        report({
          status: {
            plan: { id: "a1b2c3d4e5f60718", kind: "initial", status: "awaiting_approval", execute_on: "2026-10-05" },
            attention: ["plan a1b2c3d4e5f60718 is waiting for your signed approval"],
          },
        }),
      );
      expect(result).toEqual({ status: "recorded", snapshotStored: true });

      const mirror = await getCoreMirror(userId);
      if (!mirror.available) throw new Error("expected the mirror to be available");
      expect(mirror.status).toMatchObject({
        tradingEnabled: true,
        halted: false,
        policyEffectiveFrom: "2026-10-05",
        plan: { id: "a1b2c3d4e5f60718", kind: "initial", status: "awaiting_approval", executeOn: "2026-10-05" },
        journal: { ok: true, entries: 6, reason: null },
        tickFailures: 0,
        attention: ["plan a1b2c3d4e5f60718 is waiting for your signed approval"],
      });
      expect(mirror.status?.reportedAt.toISOString()).toBe("2026-10-05T14:00:00.000Z");
      expect(mirror.snapshot).toMatchObject({ equityUsdCents: 1_000_000, cashUsdCents: 100, lastEquityUsdCents: 999_000 });
      expect(mirror.snapshot?.positions).toHaveLength(6);
      expect(mirror.snapshot?.positions[0]).toEqual({
        symbol: "VTI",
        qty: "18.5",
        marketValueUsdCents: 190_000,
        avgEntryPriceUsdCents: 10_269,
        currentPriceUsdCents: 10_270,
      });
      expect(mirror.snapshot?.targets.VTI).toBe("0.19");
    });

    it("replaces the status with a newer report and ignores a delayed older one", async () => {
      const userId = await freshUser();
      await recordCoreReport(userId, report({ reportedAt: "2026-10-05T14:00:00.000Z" }));
      expect(await recordCoreReport(userId, report({ reportedAt: "2026-10-05T15:00:00.000Z", status: { halted: true, halt_reason: "Emergency halt" } }))).toMatchObject({ status: "recorded" });
      expect(await recordCoreReport(userId, report({ reportedAt: "2026-10-05T14:30:00.000Z" }))).toMatchObject({ status: "stale" });

      const mirror = await getCoreMirror(userId);
      if (!mirror.available) throw new Error("unavailable");
      expect(mirror.status).toMatchObject({ halted: true, haltReason: "Emergency halt" });
      expect(mirror.status?.reportedAt.toISOString()).toBe("2026-10-05T15:00:00.000Z");
    });

    it("stores one snapshot per moment, however often it is sent, and serves the newest", async () => {
      const userId = await freshUser();
      await recordCoreReport(userId, report({ reportedAt: "2026-10-05T14:00:00.000Z" }));
      expect(await recordCoreReport(userId, report({ reportedAt: "2026-10-05T14:00:00.000Z" }))).toMatchObject({ snapshotStored: false });
      await recordCoreReport(userId, report({ reportedAt: "2026-10-05T16:00:00.000Z", account: { equity_usd_cents: 1_010_000 } }));

      expect(await admin.coreSnapshot.count({ where: { userId } })).toBe(2);
      const mirror = await getCoreMirror(userId);
      if (!mirror.available) throw new Error("unavailable");
      expect(mirror.snapshot?.equityUsdCents).toBe(1_010_000);
    });

    it("updates the status without a snapshot when the report carries no account", async () => {
      const userId = await freshUser();
      expect(await recordCoreReport(userId, report({ account: null }))).toEqual({ status: "recorded", snapshotStored: false });
      expect(await admin.coreSnapshot.count({ where: { userId } })).toBe(0);
      expect(await admin.coreRouterStatus.count({ where: { userId } })).toBe(1);
    });

    it("treats a stored snapshot it can no longer read as no snapshot, not as an error", async () => {
      const userId = await freshUser();
      await admin.coreSnapshot.create({
        data: {
          userId,
          takenAt: new Date("2026-10-05T14:00:00Z"),
          equityUsdCents: 1n,
          cashUsdCents: 1n,
          positions: { not: "an array" },
          targets: {},
        },
      });
      const mirror = await getCoreMirror(userId);
      expect(mirror).toMatchObject({ available: true, snapshot: null });
    });
  });

  describe("getCoreMirror", () => {
    it("shows the most recent journal when a router's state was reset and a new one began", async () => {
      const userId = await freshUser();
      await ingestCoreJournal(userId, { chainId, entries: chain });

      const second = buildChain([{ event: "started", detail: { account: "PA0CORE00001" } }, { event: "no_plan", detail: { session: "2026-10-09", reason: "not a rebalance day" } }], new Date("2026-10-09T13:00:00.000Z"));
      expect(second[0].hash).not.toBe(chainId);
      await ingestCoreJournal(userId, { chainId: second[0].hash, entries: second });

      const mirror = await getCoreMirror(userId);
      if (!mirror.available) throw new Error("unavailable");
      expect(mirror.chainCount).toBe(2);
      expect(mirror.chainId).toBe(second[0].hash);
      expect(mirror.entries.map((e) => e.index)).toEqual([0, 1]);
    });
  });
});
