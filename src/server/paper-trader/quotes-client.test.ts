import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPaperTraderQuotes } from "./quotes-client";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyWebhookSignature } from "../../lib/webhook-signature";

const SECRET = "test-webhook-secret-for-quotes-client";

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { "Content-Type": "application/json" } });
}

describe("fetchPaperTraderQuotes()", () => {
  beforeEach(() => {
    process.env.WEBHOOK_SECRET = SECRET;
    process.env.PAPER_TRADER_SERVICE_URL = "http://trader.test";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.WEBHOOK_SECRET;
    delete process.env.PAPER_TRADER_SERVICE_URL;
  });

  it("signs the batch the same way /api/agent/halt signs its request, and parses the agent's answer", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ quotes: { TSLA: { price: "362.25", timestamp: "2026-09-18T15:30:00+00:00" } }, missing: ["ZZZZ"], feed: "iex" }),
    );
    const result = await fetchPaperTraderQuotes(["tsla", "ZZZZ", "TSLA"], fetchImpl);

    expect(result.quotes).toEqual([{ symbol: "TSLA", priceUsd: 362.25, observedAt: new Date("2026-09-18T15:30:00Z") }]);
    expect(result.missing).toEqual(["ZZZZ"]);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://trader.test/control/quotes");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ symbols: ["TSLA", "ZZZZ"] });
    const headers = init.headers as Record<string, string>;
    const verification = verifyWebhookSignature({
      rawBody: String(init.body),
      timestampHeader: headers[TIMESTAMP_HEADER],
      signatureHeader: headers[SIGNATURE_HEADER],
      secret: SECRET,
      nowMs: Date.now(),
    });
    expect(verification).toEqual({ ok: true });
  });

  it("drops a non-positive, non-numeric or undated price rather than storing garbage — untrusted input crossing a trust boundary", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        quotes: {
          A: { price: "0", timestamp: "2026-09-18T15:30:00Z" },
          B: { price: "abc", timestamp: "2026-09-18T15:30:00Z" },
          C: { price: "12.5", timestamp: "not a date" },
          D: { price: "12.5", timestamp: "2026-09-18T15:30:00Z" },
        },
        missing: [],
      }),
    );
    const result = await fetchPaperTraderQuotes(["A", "B", "C", "D"], fetchImpl);
    expect(result.quotes.map((q) => q.symbol)).toEqual(["D"]);
    expect(result.missing).toEqual(["A", "B", "C"]);
  });

  it("never stores a symbol nobody asked for", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ quotes: { EVIL: { price: "1", timestamp: "2026-09-18T15:30:00Z" } }, missing: [] }),
    );
    const result = await fetchPaperTraderQuotes(["TSLA"], fetchImpl);
    expect(result.quotes).toEqual([]);
    expect(result.missing).toEqual(["TSLA"]);
  });

  it("makes no request for an empty batch", async () => {
    const fetchImpl = vi.fn();
    expect(await fetchPaperTraderQuotes([" ", ""], fetchImpl)).toEqual({ quotes: [], missing: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws on a non-OK response and on a malformed payload — the sync reports both as a failed run", async () => {
    await expect(fetchPaperTraderQuotes(["TSLA"], vi.fn().mockResolvedValue(jsonResponse({}, { status: 502 })))).rejects.toThrow(/HTTP 502/);
    await expect(fetchPaperTraderQuotes(["TSLA"], vi.fn().mockResolvedValue(jsonResponse({ nope: true })))).rejects.toThrow();
  });
});
