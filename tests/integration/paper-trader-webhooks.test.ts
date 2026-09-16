import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { recordScenarioMetrics } from "../../src/server/dal/scenario-metrics";
import {
  _resetPaperTradingUserCacheForTests,
  resolvePaperTradingUser,
} from "../../src/server/paper-trader/resolve-paper-trading-user";

/**
 * The two server-side pieces the trader's durable outbox leans on
 * (trader integration hardening, ad hoc): resolving WHICH account a
 * signed receipt books against, and not double-counting a replayed
 * scenario-metrics delivery. Both against real Postgres — the resolver
 * is an admin-client lookup and the dedupe is a `@unique` index, neither
 * of which a mocked client would prove anything about.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("paper-trader webhooks: user resolution & metrics idempotency", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let user: { id: string; email: string };
  const originalEnv = {
    email: process.env.PAPER_TRADING_USER_EMAIL,
    id: process.env.PAPER_TRADING_USER_ID,
  };

  beforeAll(async () => {
    admin = createAdminClient();
    user = await admin.user.create({
      data: { email: `paper-trader-webhooks-${Date.now()}@pfw.local`, displayName: "Paper Trader Webhook Test" },
    });
  });

  afterEach(() => {
    process.env.PAPER_TRADING_USER_EMAIL = originalEnv.email;
    process.env.PAPER_TRADING_USER_ID = originalEnv.id;
    if (originalEnv.email === undefined) delete process.env.PAPER_TRADING_USER_EMAIL;
    if (originalEnv.id === undefined) delete process.env.PAPER_TRADING_USER_ID;
    _resetPaperTradingUserCacheForTests();
  });

  afterAll(async () => {
    await admin.scenarioMetrics.deleteMany({ where: { userId: user.id } });
    await admin.user.delete({ where: { id: user.id } });
    await admin.$disconnect();
  });

  describe("resolvePaperTradingUser()", () => {
    it("resolves by email, case-insensitively", async () => {
      process.env.PAPER_TRADING_USER_EMAIL = user.email.toUpperCase();
      delete process.env.PAPER_TRADING_USER_ID;
      _resetPaperTradingUserCacheForTests();
      expect(await resolvePaperTradingUser()).toEqual({ status: "ok", userId: user.id });
    });

    it("reports a configured email that matches no row as missing, naming the setting", async () => {
      process.env.PAPER_TRADING_USER_EMAIL = "nobody-here@pfw.local";
      _resetPaperTradingUserCacheForTests();
      expect(await resolvePaperTradingUser()).toEqual({
        status: "missing",
        configured: "PAPER_TRADING_USER_EMAIL=nobody-here@pfw.local",
      });
    });

    it("falls back to the legacy id, and reports a stale id (the re-seed failure) as missing", async () => {
      delete process.env.PAPER_TRADING_USER_EMAIL;
      process.env.PAPER_TRADING_USER_ID = user.id;
      _resetPaperTradingUserCacheForTests();
      expect(await resolvePaperTradingUser()).toEqual({ status: "ok", userId: user.id });

      process.env.PAPER_TRADING_USER_ID = "cmtn4ucmq0000kmzjnbs31nh5"; // a real id from a prior seed, long deleted
      _resetPaperTradingUserCacheForTests();
      expect(await resolvePaperTradingUser()).toEqual({
        status: "missing",
        configured: "PAPER_TRADING_USER_ID=cmtn4ucmq0000kmzjnbs31nh5",
      });
    });

    it("reports unconfigured when neither setting is present", async () => {
      delete process.env.PAPER_TRADING_USER_EMAIL;
      delete process.env.PAPER_TRADING_USER_ID;
      _resetPaperTradingUserCacheForTests();
      expect(await resolvePaperTradingUser()).toEqual({ status: "unconfigured" });
    });

    it("caches the resolution until reset, so a burst of receipts costs one lookup", async () => {
      process.env.PAPER_TRADING_USER_EMAIL = user.email;
      _resetPaperTradingUserCacheForTests();
      expect(await resolvePaperTradingUser()).toEqual({ status: "ok", userId: user.id });
      // Changing the environment without a reset must NOT change the answer yet.
      process.env.PAPER_TRADING_USER_EMAIL = "nobody-here@pfw.local";
      expect(await resolvePaperTradingUser()).toEqual({ status: "ok", userId: user.id });
    });
  });

  describe("recordScenarioMetrics()", () => {
    const base = {
      ticker: "AAPL",
      hash: "a".repeat(64),
      predictedMovePct: 6.08,
      actualFillPrice: null,
      decision: "below_min_gain",
      shadowPredictedMovePct: null,
      shadowDecision: null,
    };

    it("records a replayed delivery once and reports the second as a duplicate", async () => {
      const key = `it-metrics-${Date.now()}`;
      const first = await recordScenarioMetrics(user.id, { ...base, idempotencyKey: key });
      const second = await recordScenarioMetrics(user.id, { ...base, idempotencyKey: key });
      expect(first.created).toBe(true);
      expect(second).toEqual({ id: first.id, created: false });
      expect(await admin.scenarioMetrics.count({ where: { idempotencyKey: key } })).toBe(1);
    });

    it("keeps distinct keys as distinct rows", async () => {
      const stamp = Date.now();
      const a = await recordScenarioMetrics(user.id, { ...base, idempotencyKey: `it-metrics-${stamp}-a` });
      const b = await recordScenarioMetrics(user.id, { ...base, idempotencyKey: `it-metrics-${stamp}-b` });
      expect(a.created && b.created).toBe(true);
      expect(a.id).not.toBe(b.id);
    });

    it("always creates when no key is supplied (the pre-hardening behaviour, never an error)", async () => {
      const a = await recordScenarioMetrics(user.id, { ...base, idempotencyKey: null });
      const b = await recordScenarioMetrics(user.id, { ...base, idempotencyKey: null });
      expect(a.created && b.created).toBe(true);
      expect(a.id).not.toBe(b.id);
    });
  });
});
