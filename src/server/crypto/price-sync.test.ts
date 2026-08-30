import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLatestCryptoRates } from "./price-sync";

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { "Content-Type": "application/json" } });
}

describe("fetchLatestCryptoRates()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses a well-formed CoinGecko response into a synced rate", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ethereum: { ils: 12_345.67 } }));
    const rates = await fetchLatestCryptoRates(fetchImpl);
    expect(rates).toEqual([{ symbol: "ETH", rate: 12_345.67, asOfDate: expect.any(Date) }]);
  });

  it("discards a non-positive or non-finite quote rather than storing garbage — untrusted input crossing a trust boundary", async () => {
    const zero = await fetchLatestCryptoRates(vi.fn().mockResolvedValue(jsonResponse({ ethereum: { ils: 0 } })));
    expect(zero).toEqual([]);

    const negative = await fetchLatestCryptoRates(vi.fn().mockResolvedValue(jsonResponse({ ethereum: { ils: -5 } })));
    expect(negative).toEqual([]);
  });

  it("skips a symbol missing entirely from the response rather than throwing", async () => {
    const rates = await fetchLatestCryptoRates(vi.fn().mockResolvedValue(jsonResponse({})));
    expect(rates).toEqual([]);
  });

  it("throws on a non-OK HTTP response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, { status: 500 }));
    await expect(fetchLatestCryptoRates(fetchImpl)).rejects.toThrow(/HTTP 500/);
  });

  it("throws on a malformed payload shape", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse("not an object"));
    await expect(fetchLatestCryptoRates(fetchImpl)).rejects.toThrow(/unexpected payload/);
  });
});
