import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deriveCorePlans, describeCoreEvent, parseStoredEntries, verifyJournalChain } from "../../src/lib/core-journal";
import { POST } from "../../src/app/api/webhooks/core/route";
import { getCoreMirror } from "../../src/server/dal/core-mirror";
import { createAdminClient } from "../../src/server/db/admin-client";
import { _resetPaperTradingUserCacheForTests } from "../../src/server/paper-trader/resolve-paper-trading-user";
import {
  OTHER_SECRET_FOR_TESTS,
  WEBHOOK_SECRET_FOR_TESTS,
  buildChain,
  initialBuildSpecs,
  journalPayload,
  reportPayload,
  signedRequest,
} from "./core-sync-fixtures";

/**
 * `POST /api/webhooks/core` end to end: the real route handler, the real
 * signature check, the real account resolver and the real database with
 * RLS — everything but the network. What each layer does on its own is
 * covered where it lives (`route.test.ts` with mocks, `core-mirror.test.ts`
 * for the DAL); this proves they agree with one another, which is where a
 * wrong status code or a missed `await` would hide.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("POST /api/webhooks/core (end to end)", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let owner: { id: string; email: string };
  let bystander: { id: string };
  const original = {
    secret: process.env.WEBHOOK_SECRET,
    email: process.env.PAPER_TRADING_USER_EMAIL,
    id: process.env.PAPER_TRADING_USER_ID,
  };

  const chain = buildChain(initialBuildSpecs());
  const chainId = chain[0].hash;

  async function send(request: Request) {
    const response = await POST(request as never);
    return { status: response.status, body: await response.json() };
  }

  beforeAll(async () => {
    admin = createAdminClient();
    const stamp = Date.now();
    owner = await admin.user.create({ data: { email: `core-route-owner-${stamp}@pfw.local`, displayName: "Core Route Owner" } });
    bystander = await admin.user.create({ data: { email: `core-route-bystander-${stamp}@pfw.local`, displayName: "Bystander" } });
  });

  beforeEach(async () => {
    process.env.WEBHOOK_SECRET = WEBHOOK_SECRET_FOR_TESTS;
    process.env.PAPER_TRADING_USER_EMAIL = owner.email;
    delete process.env.PAPER_TRADING_USER_ID;
    _resetPaperTradingUserCacheForTests();
    await admin.coreJournalEntry.deleteMany({ where: { userId: { in: [owner.id, bystander.id] } } });
    await admin.coreSnapshot.deleteMany({ where: { userId: { in: [owner.id, bystander.id] } } });
    await admin.coreRouterStatus.deleteMany({ where: { userId: { in: [owner.id, bystander.id] } } });
  });

  afterEach(() => {
    _resetPaperTradingUserCacheForTests();
  });

  afterAll(async () => {
    process.env.WEBHOOK_SECRET = original.secret;
    if (original.secret === undefined) delete process.env.WEBHOOK_SECRET;
    process.env.PAPER_TRADING_USER_EMAIL = original.email;
    if (original.email === undefined) delete process.env.PAPER_TRADING_USER_EMAIL;
    process.env.PAPER_TRADING_USER_ID = original.id;
    if (original.id === undefined) delete process.env.PAPER_TRADING_USER_ID;
    _resetPaperTradingUserCacheForTests();
    await admin.user.deleteMany({ where: { id: { in: [owner.id, bystander.id] } } });
    await admin.$disconnect();
  });

  it("mirrors a whole session: journal, replay, report, and an older report arriving late", async () => {
    const first = await send(signedRequest(journalPayload(chainId, chain)));
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ ok: true, status: "recorded", chain_id: chainId, accepted: 6, duplicates: 0, next_index: 6 });

    const replay = await send(signedRequest(journalPayload(chainId, chain)));
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ status: "duplicate", accepted: 0, duplicates: 6, next_index: 6 });

    const report = await send(signedRequest(reportPayload({ reportedAt: "2026-10-05T15:00:00.000Z" })));
    expect(report.status).toBe(201);
    expect(report.body).toEqual({ ok: true, status: "recorded", snapshot_stored: true });

    const late = await send(signedRequest(reportPayload({ reportedAt: "2026-10-05T14:00:00.000Z" })));
    expect(late.status).toBe(200);
    expect(late.body).toMatchObject({ status: "stale" });

    const mirror = await getCoreMirror(owner.id);
    if (!mirror.available) throw new Error("unavailable");
    expect(verifyJournalChain(mirror.entries)).toMatchObject({ ok: true, entries: 6 });
    expect(mirror.status?.reportedAt.toISOString()).toBe("2026-10-05T15:00:00.000Z");
    expect(mirror.snapshot?.equityUsdCents).toBe(1_000_000);
  });

  it("writes only the configured account's mirror, whoever the body names", async () => {
    await send(signedRequest({ ...journalPayload(chainId, chain), user_id: bystander.id, email: "x@y.z" }));
    expect(await admin.coreJournalEntry.count({ where: { userId: owner.id } })).toBe(6);
    expect(await admin.coreJournalEntry.count({ where: { userId: bystander.id } })).toBe(0);
  });

  it("stores nothing for an unsigned or wrongly signed request", async () => {
    expect((await send(signedRequest(journalPayload(chainId, chain), { secret: OTHER_SECRET_FOR_TESTS }))).status).toBe(403);
    expect((await send(signedRequest(journalPayload(chainId, chain), { signature: "" }))).status).toBe(403);
    expect(await admin.coreJournalEntry.count({ where: { userId: owner.id } })).toBe(0);
  });

  it("lets a router that is ahead of the mirror (a restored database) rewind and catch up", async () => {
    await send(signedRequest(journalPayload(chainId, chain.slice(0, 3))));

    const ahead = await send(signedRequest(journalPayload(chainId, chain.slice(5))));
    expect(ahead.status).toBe(409);
    expect(ahead.body).toEqual({ ok: false, error: "gap", next_index: 3 });

    const caughtUp = await send(signedRequest(journalPayload(chainId, chain.slice(3))));
    expect(caughtUp.status).toBe(201);
    expect(caughtUp.body).toMatchObject({ next_index: 6 });
  });

  it("refuses a different history for an entry it already holds", async () => {
    await send(signedRequest(journalPayload(chainId, chain)));
    const forked = buildChain([
      ...initialBuildSpecs().slice(0, 3),
      { event: "plan_expired", detail: { plan_id: "a1b2c3d4e5f60718", kind: "initial", reason: "forked", orders: {} } },
    ]);
    const result = await send(signedRequest(journalPayload(chainId, forked.slice(2))));
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: "chain_conflict", index: 3 });
  });

  it("refuses a batch whose lines do not match their hashes", async () => {
    const tampered = chain.map((e) => ({ ...e }));
    tampered[1].raw = tampered[1].raw.replace("awaiting_approval", "approved");
    const result = await send(signedRequest(journalPayload(chainId, tampered)));
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: "invalid_entry" });
    expect(await admin.coreJournalEntry.count({ where: { userId: owner.id } })).toBe(0);
  });

  /**
   * The contract with the other repository. `core-sync-contract.json` is the
   * pair of request bodies `~/paper-trader`'s own `core_sync` produced for a
   * whole initial build driven through its real router (a copy of that
   * repo's `tests/fixtures/pfw_core_sync_contract.json`, regenerated there
   * with `UPDATE_PFW_FIXTURE=1`). Replaying them byte for byte — Python's
   * canonical JSON, signed over those exact bytes — proves this route, the
   * schema, the journal parser and the plan replay all accept what the
   * trader really sends, which the hand-built fixtures above can only
   * imitate.
   */
  describe("the trader's own payloads", () => {
    const fixture = JSON.parse(readFileSync(path.join(__dirname, "../fixtures/core-sync-contract.json"), "utf8")) as {
      journal_body: string;
      report_body: string;
    };

    it("are accepted as sent, and read back as the initial build they describe", async () => {
      const journal = await send(signedRequest(null, { body: fixture.journal_body }));
      expect(journal.status).toBe(201);
      expect(journal.body).toMatchObject({ ok: true, status: "recorded", accepted: 10, duplicates: 0, next_index: 10 });

      const report = await send(signedRequest(null, { body: fixture.report_body }));
      expect(report.status).toBe(201);
      expect(report.body).toEqual({ ok: true, status: "recorded", snapshot_stored: true });

      const mirror = await getCoreMirror(owner.id);
      if (!mirror.available) throw new Error("unavailable");
      expect(verifyJournalChain(mirror.entries)).toMatchObject({ ok: true, entries: 10 });

      const entries = parseStoredEntries(mirror.entries);
      const [plan, ...others] = deriveCorePlans(entries);
      expect(others).toEqual([]);
      expect(plan).toMatchObject({ kind: "initial", status: "done", fundedByOwner: true, decidedOn: "2026-09-30", executeOn: "2026-10-01" });
      expect(plan.orders).toHaveLength(6);
      expect(plan.orders.every((order) => order.status === "filled" && order.filledQty && order.filledAvgPrice)).toBe(true);
      expect(plan.buys).toHaveLength(6);
      expect(plan.tradedUsdCents).toBeGreaterThan(900_000); // most of the $9,999 the plan spends

      const labels = entries.map((entry) => describeCoreEvent(entry).label);
      expect(labels[0]).toBe("Router started");
      expect(labels.at(-1)).toMatch(/^Plan [0-9a-f]{8} done$/);

      expect(mirror.status).toMatchObject({ tradingEnabled: true, halted: false, journal: { ok: true, entries: 10 } });
      expect(mirror.snapshot?.positions.map((p) => p.symbol)).toEqual(["VTI", "BIL"]);
      expect(mirror.snapshot?.equityUsdCents).toBe(1_000_013);
    });

    it("are answered as duplicates when the router sends them again, which is what its retry does", async () => {
      await send(signedRequest(null, { body: fixture.journal_body }));
      const again = await send(signedRequest(null, { body: fixture.journal_body }));
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ status: "duplicate", accepted: 0, duplicates: 10, next_index: 10 });
    });
  });

  it("answers 503 when no paper-trading account is configured, and again once it is, losing nothing", async () => {
    process.env.PAPER_TRADING_USER_EMAIL = "nobody-here@pfw.local";
    _resetPaperTradingUserCacheForTests();
    const refused = await send(signedRequest(journalPayload(chainId, chain)));
    expect(refused.status).toBe(503);
    expect(refused.body.error).toBe("paper_trading_user_unresolved");

    process.env.PAPER_TRADING_USER_EMAIL = owner.email;
    _resetPaperTradingUserCacheForTests();
    expect((await send(signedRequest(journalPayload(chainId, chain)))).status).toBe(201);
  });
});
