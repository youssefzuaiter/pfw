import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  OTHER_SECRET_FOR_TESTS,
  WEBHOOK_SECRET_FOR_TESTS,
  buildChain,
  initialBuildSpecs,
  journalPayload,
  reportPayload,
  signedRequest,
} from "../../../../../tests/integration/core-sync-fixtures";

const resolvePaperTradingUser = vi.fn();
const ingestCoreJournal = vi.fn();
const recordCoreReport = vi.fn();
let secret: string | Error = WEBHOOK_SECRET_FOR_TESTS;

vi.mock("../../../../server/env", () => ({
  getWebhookSecret: () => {
    if (secret instanceof Error) throw secret;
    return secret;
  },
}));
vi.mock("../../../../server/paper-trader/resolve-paper-trading-user", () => ({
  resolvePaperTradingUser: (...args: unknown[]) => resolvePaperTradingUser(...args),
}));
vi.mock("../../../../server/dal/core-mirror", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../server/dal/core-mirror")>();
  return {
    ...actual,
    ingestCoreJournal: (...args: unknown[]) => ingestCoreJournal(...args),
    recordCoreReport: (...args: unknown[]) => recordCoreReport(...args),
  };
});

import { CoreMirrorUnavailableError } from "../../../../server/dal/core-mirror";
import { POST } from "./route";

/**
 * The route's own job: authenticate the caller by the HMAC over the raw
 * bytes BEFORE reading a field of them, map every outcome of the DAL to a
 * status code the router's sync loop can act on, and never let a failure
 * look like success. The mirror's semantics are tested in
 * `tests/integration/core-mirror.test.ts`; end to end, with a real
 * database, in `tests/integration/core-webhook-route.test.ts`.
 */
const chain = buildChain(initialBuildSpecs());
const journal = () => journalPayload(chain[0].hash, chain);

async function call(request: Request) {
  const response = await POST(request as never);
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  secret = WEBHOOK_SECRET_FOR_TESTS;
  resolvePaperTradingUser.mockReset().mockResolvedValue({ status: "ok", userId: "user-1" });
  ingestCoreJournal.mockReset();
  recordCoreReport.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("POST /api/webhooks/core: who may call it", () => {
  it.each([
    ["a wrong secret", { secret: OTHER_SECRET_FOR_TESTS }],
    ["a missing signature", { signature: "" }],
    ["a stale timestamp", { timestamp: String(Math.floor(Date.now() / 1000) - 3600) }],
    ["a malformed timestamp", { timestamp: "yesterday" }],
  ])("refuses %s with a 403 and touches nothing", async (_label, options) => {
    const { status, body } = await call(signedRequest(journal(), options));
    expect(status).toBe(403);
    expect(body).toEqual({ error: "Invalid signature" });
    expect(resolvePaperTradingUser).not.toHaveBeenCalled();
    expect(ingestCoreJournal).not.toHaveBeenCalled();
  });

  it("refuses a body changed after it was signed", async () => {
    const signed = signedRequest(journal());
    const original = await signed.clone().text();
    const forged = new Request(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: original.replace("started", "startee"),
    });
    expect((await call(forged)).status).toBe(403);
    expect(ingestCoreJournal).not.toHaveBeenCalled();
  });

  it("does not parse a body it has not authenticated: an unsigned non-JSON body is a 403, not a 400", async () => {
    const { status } = await call(signedRequest(null, { body: "{not json", signature: "sha256=deadbeef" }));
    expect(status).toBe(403);
  });

  it("answers 500, not a guess, when the shared secret is not configured", async () => {
    secret = new Error("Missing required server-only environment variable: WEBHOOK_SECRET");
    expect((await call(signedRequest(journal()))).status).toBe(500);
    expect(ingestCoreJournal).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/core: what it accepts", () => {
  it("answers 400 for a signed body that is not JSON", async () => {
    const { status, body } = await call(signedRequest(null, { body: "{not json" }));
    expect(status).toBe(400);
    expect(body.error).toMatch(/json/i);
  });

  it("answers 400 with the problems for a signed body that breaks the contract", async () => {
    const { status, body } = await call(signedRequest({ ...journal(), entries: [] }));
    expect(status).toBe(400);
    expect(body.error).toBe("Invalid core sync payload");
    expect(Array.isArray(body.details)).toBe(true);
    expect(ingestCoreJournal).not.toHaveBeenCalled();
  });

  it("answers 503, which the router retries, when no paper-trading account is configured", async () => {
    resolvePaperTradingUser.mockResolvedValue({ status: "unconfigured" });
    const { status, body } = await call(signedRequest(journal()));
    expect(status).toBe(503);
    expect(body.error).toBe("paper_trading_user_unresolved");
    expect(ingestCoreJournal).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/core: journal batches", () => {
  it("passes the batch to the mirror for the resolved user — never one named in the body", async () => {
    ingestCoreJournal.mockResolvedValue({ status: "recorded", accepted: 6, duplicates: 0, nextIndex: 6 });
    const { status, body } = await call(signedRequest({ ...journal(), user_id: "someone-else", userId: "someone-else" }));
    expect(status).toBe(201);
    expect(body).toEqual({ ok: true, status: "recorded", chain_id: chain[0].hash, accepted: 6, duplicates: 0, next_index: 6 });
    expect(ingestCoreJournal).toHaveBeenCalledWith("user-1", {
      chainId: chain[0].hash,
      entries: chain.map((e) => ({ index: e.index, hash: e.hash, prev: e.prev, raw: e.raw })),
    });
  });

  it("answers a replay with 200 and where the mirror now is, so the router can move its cursor", async () => {
    ingestCoreJournal.mockResolvedValue({ status: "duplicate", accepted: 0, duplicates: 6, nextIndex: 6 });
    const { status, body } = await call(signedRequest(journal()));
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: "duplicate", next_index: 6 });
  });

  it("answers a gap with 409 and the index the mirror expects (a restored database)", async () => {
    ingestCoreJournal.mockResolvedValue({ status: "gap", nextIndex: 3 });
    const { status, body } = await call(signedRequest(journal()));
    expect(status).toBe(409);
    expect(body).toEqual({ ok: false, error: "gap", next_index: 3 });
  });

  it("answers a fork with 409 chain_conflict", async () => {
    ingestCoreJournal.mockResolvedValue({ status: "conflict", index: 3, detail: "the mirror already holds a different entry at this index" });
    const { status, body } = await call(signedRequest(journal()));
    expect(status).toBe(409);
    expect(body).toMatchObject({ ok: false, error: "chain_conflict", index: 3 });
  });

  it("answers a batch that contradicts itself with 400 invalid_entry", async () => {
    ingestCoreJournal.mockResolvedValue({ status: "invalid", detail: "entry 2: the line does not hash to the entry's hash" });
    const { status, body } = await call(signedRequest(journal()));
    expect(status).toBe(400);
    expect(body).toMatchObject({ ok: false, error: "invalid_entry" });
  });

  it("answers 503 when the mirror tables are not there yet, so the router keeps its place and tries again", async () => {
    ingestCoreJournal.mockRejectedValue(new CoreMirrorUnavailableError(new Error("P2021")));
    const { status, body } = await call(signedRequest(journal()));
    expect(status).toBe(503);
    expect(body).toMatchObject({ ok: false, error: "core_mirror_unavailable" });
  });

  it("answers an unexpected failure with a bare 500: no stack, no message", async () => {
    ingestCoreJournal.mockRejectedValue(new Error("password authentication failed for user pfw_runtime"));
    const { status, body } = await call(signedRequest(journal()));
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toMatch(/password|pfw_runtime/);
  });
});

describe("POST /api/webhooks/core: reports", () => {
  it("records a report and says whether it stored a snapshot", async () => {
    recordCoreReport.mockResolvedValue({ status: "recorded", snapshotStored: true });
    const { status, body } = await call(signedRequest(reportPayload()));
    expect(status).toBe(201);
    expect(body).toEqual({ ok: true, status: "recorded", snapshot_stored: true });
    expect(recordCoreReport).toHaveBeenCalledWith("user-1", expect.objectContaining({ kind: "report" }));
  });

  it("answers a report older than the one it holds with 200, since the router has nothing to fix", async () => {
    recordCoreReport.mockResolvedValue({ status: "stale", snapshotStored: false });
    const { status, body } = await call(signedRequest(reportPayload()));
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: "stale" });
  });

  it("answers 503 for missing tables here too", async () => {
    recordCoreReport.mockRejectedValue(new CoreMirrorUnavailableError(new Error("P2022")));
    expect((await call(signedRequest(reportPayload()))).status).toBe(503);
  });
});
