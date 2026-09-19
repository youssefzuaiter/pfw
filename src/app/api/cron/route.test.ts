import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The operator-alert wiring only (AGENTS.md §3yy): every job module is
 * mocked so this asserts what the route does with their OUTCOMES — one
 * email per run, every failed job listed, the stale-data breaker named —
 * not what the jobs themselves do (each has its own tests).
 */
vi.mock("../../../server/env", () => ({
  getCronSecret: () => "cron-secret-for-route-test",
  // key-rotation.ts's own real (unmocked) import of this same module —
  // this route test exercises its genuine no-op guard, not a stand-in
  // for it, so this must still behave like the ordinary, non-rotating
  // default rather than being silently undefined.
  getEncryptionKeyNext: () => null,
}));
vi.mock("../../../server/currency/rate-sync", () => ({ syncExchangeRates: vi.fn() }));
vi.mock("../../../server/crypto/price-sync", () => ({ syncCryptoPrices: vi.fn() }));
vi.mock("../../../server/market-data/quote-sync", () => ({ syncEquityQuotes: vi.fn() }));
vi.mock("../../../server/dead-mans-switch/inactivity-check", () => ({ runInactivityCheck: vi.fn() }));
vi.mock("../../../server/dal/rate-limit-buckets", () => ({ deleteExpiredRateLimitBuckets: vi.fn() }));
vi.mock("../../../server/crypto/key-rotation", () => ({ runEncryptionKeyRotationSweep: vi.fn() }));
vi.mock("../../../server/ops/operator-alert", () => ({ sendOperatorAlert: vi.fn() }));

import { GET } from "./route";
import { syncExchangeRates } from "../../../server/currency/rate-sync";
import { syncCryptoPrices } from "../../../server/crypto/price-sync";
import { syncEquityQuotes } from "../../../server/market-data/quote-sync";
import { runInactivityCheck } from "../../../server/dead-mans-switch/inactivity-check";
import { deleteExpiredRateLimitBuckets } from "../../../server/dal/rate-limit-buckets";
import { runEncryptionKeyRotationSweep } from "../../../server/crypto/key-rotation";
import { sendOperatorAlert } from "../../../server/ops/operator-alert";
import { StaleDataError } from "../../../server/stale-data-error";

const ok = { ok: true as const };

function request(): NextRequest {
  return new NextRequest("http://localhost/api/cron", { headers: { authorization: "Bearer cron-secret-for-route-test" } });
}

function allHealthy() {
  vi.mocked(syncExchangeRates).mockResolvedValue({ ok: true, synced: 3 } as never);
  vi.mocked(syncCryptoPrices).mockResolvedValue({ ok: true, synced: 2 } as never);
  vi.mocked(syncEquityQuotes).mockResolvedValue({ ok: true, synced: ["TSLA"], skipped: [] } as never);
  vi.mocked(runInactivityCheck).mockResolvedValue({ movedToGracePeriod: [], triggered: [] } as never);
  vi.mocked(deleteExpiredRateLimitBuckets).mockResolvedValue(0 as never);
  vi.mocked(runEncryptionKeyRotationSweep).mockResolvedValue({ ok: true, inProgress: false } as never);
}

describe("GET /api/cron operator alert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(sendOperatorAlert).mockResolvedValue("sent");
  });

  it("sends nothing when every job succeeds", async () => {
    allHealthy();
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ fxRateSync: ok, equityQuoteSync: ok, rateLimitCleanup: ok, operatorAlert: "not_needed" });
    expect(sendOperatorAlert).not.toHaveBeenCalled();
  });

  it("sends ONE email listing every failed job, and names the stale-data breaker", async () => {
    allHealthy();
    vi.mocked(syncCryptoPrices).mockRejectedValue(new StaleDataError("CoinGecko unreachable and stored rate is 3 days old"));
    vi.mocked(syncEquityQuotes).mockResolvedValue({ ok: false, error: "paper trader HTTP 404" } as never);

    const res = await GET(request());
    const body = await res.json();
    expect(body.operatorAlert).toBe("sent");
    expect(body.cryptoPriceSync).toEqual({ ok: false, error: "CoinGecko unreachable and stored rate is 3 days old", staleData: true });
    expect(body.equityQuoteSync).toEqual({ ok: false, error: "paper trader HTTP 404", staleData: false });

    expect(sendOperatorAlert).toHaveBeenCalledTimes(1);
    const alert = vi.mocked(sendOperatorAlert).mock.calls[0][0];
    expect(alert.subject).toBe("cron: 2 job(s) failed — STALE-DATA BREAKER TRIPPED");
    expect(alert.lines).toEqual([
      "cryptoPriceSync: [stale data] CoinGecko unreachable and stored rate is 3 days old",
      "equityQuoteSync: paper trader HTTP 404",
    ]);
  });

  it("reports the alert's own outcome without failing the run — a not-configured or failed send is still a 200", async () => {
    allHealthy();
    vi.mocked(runInactivityCheck).mockRejectedValue(new Error("db down"));
    vi.mocked(sendOperatorAlert).mockResolvedValue("not_configured");

    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.operatorAlert).toBe("not_configured");
    expect(vi.mocked(sendOperatorAlert).mock.calls[0][0].subject).toBe("cron: 1 job(s) failed");
  });

  it("reports a genuine no-op cleanly when no rotation is in progress", async () => {
    allHealthy();
    const res = await GET(request());
    const body = await res.json();
    expect(body.encryptionKeyRotation).toEqual({ ok: true });
    expect(body.operatorAlert).toBe("not_needed");
  });

  it("stays healthy when a rotation IS in progress but every row succeeded", async () => {
    allHealthy();
    vi.mocked(runEncryptionKeyRotationSweep).mockResolvedValue({
      ok: true,
      inProgress: true,
      reencrypted: 12,
      remaining: 3,
      failed: 0,
    } as never);

    const res = await GET(request());
    const body = await res.json();
    expect(body.encryptionKeyRotation).toEqual({ ok: true });
    expect(body.operatorAlert).toBe("not_needed");
    expect(sendOperatorAlert).not.toHaveBeenCalled();
  });

  it("alerts the operator when a rotation sweep leaves per-row failures, even though the module's own result is ok:true", async () => {
    allHealthy();
    vi.mocked(runEncryptionKeyRotationSweep).mockResolvedValue({
      ok: true,
      inProgress: true,
      reencrypted: 5,
      remaining: 2,
      failed: 2,
    } as never);

    const res = await GET(request());
    const body = await res.json();
    expect(body.encryptionKeyRotation).toEqual({
      ok: false,
      error: "2 row(s) failed to re-encrypt this run (2 still remaining)",
      staleData: false,
    });
    expect(body.operatorAlert).toBe("sent");
    const alert = vi.mocked(sendOperatorAlert).mock.calls[0][0];
    expect(alert.lines).toEqual(["encryptionKeyRotation: 2 row(s) failed to re-encrypt this run (2 still remaining)"]);
  });

  it("alerts the operator when the sweep itself fails outright (e.g. a lost DB connection mid-rotation)", async () => {
    allHealthy();
    vi.mocked(runEncryptionKeyRotationSweep).mockResolvedValue({
      ok: false,
      inProgress: true,
      error: "connection terminated unexpectedly",
    } as never);

    const res = await GET(request());
    const body = await res.json();
    expect(body.encryptionKeyRotation).toEqual({ ok: false, error: "connection terminated unexpectedly", staleData: false });
    expect(body.operatorAlert).toBe("sent");
  });

  it("still refuses a wrong secret before running anything", async () => {
    allHealthy();
    const res = await GET(new NextRequest("http://localhost/api/cron", { headers: { authorization: "Bearer nope" } }));
    expect(res.status).toBe(403);
    expect(syncExchangeRates).not.toHaveBeenCalled();
    expect(runEncryptionKeyRotationSweep).not.toHaveBeenCalled();
    expect(sendOperatorAlert).not.toHaveBeenCalled();
  });
});
