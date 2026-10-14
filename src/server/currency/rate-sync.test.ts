import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../dal/exchange-rates", () => ({
  currenciesToSync: () => ["USD", "EUR", "GBP", "TRY"],
  getEarliestRateDays: vi.fn(),
  insertMissingRates: vi.fn(),
  getLatestRateFetchedAt: vi.fn(),
  upsertRate: vi.fn(),
  getLatestRateTable: vi.fn(),
}));

import { RATE_HISTORY_DAYS, RATE_HISTORY_REFRESH_DAYS, fetchRateHistory, syncRateHistory } from "./rate-sync";
import { getEarliestRateDays, insertMissingRates } from "../dal/exchange-rates";

/**
 * The exchange-rate history sync (AGENTS.md §3vvv): the whole window when
 * any currency's history starts too late, otherwise only the recent days;
 * one request, one insert; the provider's answer treated as untrusted.
 */
const NOW = new Date("2026-10-14T00:05:00Z");

function seriesResponse(rates: Record<string, Record<string, number>>, base = "ILS") {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => ({ amount: 1, base, start_date: "x", end_date: "y", rates }) });
}

describe("fetchRateHistory", () => {
  it("asks for the range in one request and inverts every quote to ILS per unit", async () => {
    // Friday and Monday only: the provider publishes no weekend rows.
    const fetchMock = seriesResponse({ "2026-08-28": { USD: 0.25, TRY: 16 }, "2026-08-31": { USD: 0.2 } });
    const rates = await fetchRateHistory("2026-08-28", "2026-08-31", fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.frankfurter.dev/v1/2026-08-28..2026-08-31?base=ILS&symbols=USD,EUR,GBP,TRY");
    expect(rates).toEqual([
      { currency: "USD", rate: 4, asOfDate: new Date("2026-08-28T00:00:00Z") },
      { currency: "TRY", rate: 0.0625, asOfDate: new Date("2026-08-28T00:00:00Z") },
      { currency: "USD", rate: 5, asOfDate: new Date("2026-08-31T00:00:00Z") },
    ]);
  });

  it("drops unsupported currencies and zero, negative or non-finite quotes", async () => {
    const fetchMock = seriesResponse({ "2026-08-28": { USD: 0, EUR: -1, JPY: 40, GBP: 0.2 } });
    const rates = await fetchRateHistory("2026-08-28", "2026-08-28", fetchMock as unknown as typeof fetch);
    expect(rates.map((rate) => rate.currency)).toEqual(["GBP"]);
  });

  it("refuses a malformed answer, the wrong base, or an HTTP error", async () => {
    await expect(fetchRateHistory("a", "b", seriesResponse({ "not-a-day": { USD: 1 } }) as unknown as typeof fetch)).rejects.toThrow(/unexpected payload/);
    await expect(fetchRateHistory("a", "b", seriesResponse({}, "EUR") as unknown as typeof fetch)).rejects.toThrow(/base EUR/);
    const failing = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(fetchRateHistory("a", "b", failing as unknown as typeof fetch)).rejects.toThrow(/HTTP 503/);
  });
});

describe("syncRateHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(insertMissingRates).mockResolvedValue(3);
  });

  function requestedRange(fetchMock: ReturnType<typeof vi.fn>): string {
    return /v1\/([\d-]+\.\.[\d-]+)\?/.exec(fetchMock.mock.calls[0][0] as string)![1];
  }

  it("fetches the whole window when any currency's history starts too late", async () => {
    const complete = new Date(NOW.getTime() - RATE_HISTORY_DAYS * 86_400_000);
    vi.mocked(getEarliestRateDays).mockResolvedValue(
      new Map([
        ["USD", complete],
        ["EUR", complete],
        ["GBP", complete],
        ["TRY", new Date("2026-09-18T00:00:00Z")], // TRY was added later
      ]),
    );
    const fetchMock = seriesResponse({ "2026-10-13": { USD: 0.33 } });
    const result = await syncRateHistory(NOW, fetchMock as unknown as typeof fetch);

    expect(requestedRange(fetchMock)).toBe(`${complete.toISOString().slice(0, 10)}..2026-10-14`);
    expect(result).toEqual({ ok: true, from: complete.toISOString().slice(0, 10), to: "2026-10-14", fetched: 1, added: 3 });
    expect(vi.mocked(insertMissingRates).mock.calls[0][0]).toEqual([
      { currency: "USD", rate: 1 / 0.33, asOfDate: new Date("2026-10-13T00:00:00Z"), source: "frankfurter.dev (ECB) history" },
    ]);
  });

  it("fetches the whole window when nothing is stored yet", async () => {
    vi.mocked(getEarliestRateDays).mockResolvedValue(new Map());
    const fetchMock = seriesResponse({});
    await syncRateHistory(NOW, fetchMock as unknown as typeof fetch);
    expect(requestedRange(fetchMock).startsWith("2023-")).toBe(true);
  });

  it("only re-reads the recent days once the history is complete", async () => {
    const complete = new Date(NOW.getTime() - (RATE_HISTORY_DAYS + 1) * 86_400_000);
    vi.mocked(getEarliestRateDays).mockResolvedValue(new Map(["USD", "EUR", "GBP", "TRY"].map((c) => [c as "USD", complete])));
    const fetchMock = seriesResponse({});
    await syncRateHistory(NOW, fetchMock as unknown as typeof fetch);
    const from = new Date(NOW.getTime() - RATE_HISTORY_REFRESH_DAYS * 86_400_000).toISOString().slice(0, 10);
    expect(requestedRange(fetchMock)).toBe(`${from}..2026-10-14`);
  });

  it("reports a failure instead of throwing", async () => {
    vi.mocked(getEarliestRateDays).mockResolvedValue(new Map());
    const failing = vi.fn().mockRejectedValue(new Error("network down"));
    expect(await syncRateHistory(NOW, failing as unknown as typeof fetch)).toEqual({ ok: false, error: "network down" });
    expect(insertMissingRates).not.toHaveBeenCalled();
  });
});
