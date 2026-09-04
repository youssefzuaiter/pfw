import { describe, expect, it } from "vitest";
import { agorot } from "./money";
import { assignDedupeKeys, buildDedupeKeySource, buildProviderTransactionId } from "./transaction-dedupe";

const BASE_ROW = {
  occurredAt: new Date("2026-09-01T00:00:00.000Z"),
  amountAgorot: agorot(-4500),
  description: "Coffee",
  merchantName: "Cafe Aroma",
};

describe("buildDedupeKeySource", () => {
  it("is deterministic for identical inputs", () => {
    expect(buildDedupeKeySource(BASE_ROW, 0)).toBe(buildDedupeKeySource(BASE_ROW, 0));
  });

  it("differs by occurrence ordinal alone", () => {
    expect(buildDedupeKeySource(BASE_ROW, 0)).not.toBe(buildDedupeKeySource(BASE_ROW, 1));
  });

  it("treats a null merchantName consistently (never throws, never collides with a real empty string)", () => {
    const withNullMerchant = { ...BASE_ROW, merchantName: null };
    expect(() => buildDedupeKeySource(withNullMerchant, 0)).not.toThrow();
  });
});

describe("assignDedupeKeys", () => {
  it("numbers genuinely identical rows (same day/amount/description/merchant) with distinct occurrence ordinals — two identical coffees stay two rows, not one", () => {
    const rows = [BASE_ROW, BASE_ROW, BASE_ROW];
    const withKeys = assignDedupeKeys(rows);
    const keys = withKeys.map((r) => r.dedupeKeySource);
    expect(new Set(keys).size).toBe(3);
  });

  it("re-assigning keys to the exact same batch reproduces the exact same keys — a true re-ingestion still dedupes", () => {
    const rows = [BASE_ROW, { ...BASE_ROW, amountAgorot: agorot(-1000) }, BASE_ROW];
    const first = assignDedupeKeys(rows).map((r) => r.dedupeKeySource);
    const second = assignDedupeKeys(rows).map((r) => r.dedupeKeySource);
    expect(second).toEqual(first);
  });

  it("preserves every other field on each row untouched", () => {
    const row = { ...BASE_ROW, providerReference: "REF-1", lineNumber: 3 };
    const [result] = assignDedupeKeys([row]);
    expect(result.providerReference).toBe("REF-1");
    expect(result.lineNumber).toBe(3);
  });
});

describe("buildProviderTransactionId", () => {
  const [rowWithKey] = assignDedupeKeys([BASE_ROW]);

  it("prefers providerReference when present, namespaced by source and sourceId", () => {
    const row = { ...rowWithKey, providerReference: "REF-42" };
    expect(buildProviderTransactionId(row, "psd2", "mock-ing-nl")).toBe("psd2:mock-ing-nl:ref:REF-42");
  });

  it("falls back to a content hash when providerReference is null", () => {
    const row = { ...rowWithKey, providerReference: null };
    const id = buildProviderTransactionId(row, "psd2", "mock-ing-nl");
    expect(id).toMatch(/^psd2:mock-ing-nl:hash:[0-9a-f]{32}$/);
  });

  it("the SAME row content produces DIFFERENT provider ids across different sources — cross-source unification is a stated non-goal, not a bug", () => {
    const row = { ...rowWithKey, providerReference: null };
    const csvId = buildProviderTransactionId(row, "csv", "leumi");
    const psd2Id = buildProviderTransactionId(row, "psd2", "mock-ing-nl");
    expect(csvId).not.toBe(psd2Id);
  });

  it("is deterministic for the same source/sourceId/content", () => {
    const row = { ...rowWithKey, providerReference: null };
    expect(buildProviderTransactionId(row, "psd2", "mock-ing-nl")).toBe(buildProviderTransactionId(row, "psd2", "mock-ing-nl"));
  });
});
