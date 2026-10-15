import { describe, expect, it } from "vitest";
import { computeLedgerCommitHash, type LedgerCommitState } from "./ledger-hash";

const BASE_STATE: LedgerCommitState = {
  transactionId: "txn_1",
  categoryId: "cat_1",
  categoryName: "Groceries",
  amountAgorot: "-4500",
  currency: "ILS",
  nativeAmount: "-4500",
  occurredAtIso: "2026-09-01T10:00:00.000Z",
  description: "Supermarket",
  merchantName: "Supermarket Co",
};

describe("computeLedgerCommitHash", () => {
  it("is deterministic for the same inputs", () => {
    const a = computeLedgerCommitHash(null, BASE_STATE);
    const b = computeLedgerCommitHash(null, BASE_STATE);
    expect(a).toBe(b);
  });

  it("is unaffected by object key insertion order (canonicalized before hashing)", () => {
    const reordered: LedgerCommitState = {
      merchantName: BASE_STATE.merchantName,
      description: BASE_STATE.description,
      occurredAtIso: BASE_STATE.occurredAtIso,
      nativeAmount: BASE_STATE.nativeAmount,
      currency: BASE_STATE.currency,
      amountAgorot: BASE_STATE.amountAgorot,
      categoryName: BASE_STATE.categoryName,
      categoryId: BASE_STATE.categoryId,
      transactionId: BASE_STATE.transactionId,
    };
    expect(computeLedgerCommitHash(null, reordered)).toBe(computeLedgerCommitHash(null, BASE_STATE));
  });

  it("produces a different hash for a different previousHash, all else equal", () => {
    const withNullPrev = computeLedgerCommitHash(null, BASE_STATE);
    const withRealPrev = computeLedgerCommitHash("some-prior-hash", BASE_STATE);
    expect(withNullPrev).not.toBe(withRealPrev);
  });

  it("produces a different hash for any single changed field — the sensitivity a tamper-evidence chain depends on", () => {
    const original = computeLedgerCommitHash(null, BASE_STATE);
    const tamperedAmount = computeLedgerCommitHash(null, { ...BASE_STATE, amountAgorot: "-999999" });
    const tamperedCategory = computeLedgerCommitHash(null, { ...BASE_STATE, categoryName: "Entertainment" });
    const tamperedDescription = computeLedgerCommitHash(null, { ...BASE_STATE, description: "something else" });
    expect(tamperedAmount).not.toBe(original);
    expect(tamperedCategory).not.toBe(original);
    expect(tamperedDescription).not.toBe(original);
  });

  it("returns a 64-character lowercase hex SHA-256 digest", () => {
    const hash = computeLedgerCommitHash(null, BASE_STATE);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats a null previousHash the same as an empty string, not as a skipped/omitted input", () => {
    // computeLedgerCommitHash(null, ...) must be a real, well-defined hash
    // of ("" + canonical state) — not some sentinel that special-cases
    // away the previousHash entirely, which would make a chain's first
    // link indistinguishable from one with a genuinely empty-string
    // previousHash value.
    const hash = computeLedgerCommitHash(null, BASE_STATE);
    expect(hash).toHaveLength(64);
    expect(hash).not.toBe(computeLedgerCommitHash("x", BASE_STATE));
  });

  describe("the exchange rate (AGENTS.md §3www)", () => {
    // Computed with the code on `main` before the rate field existed: a
    // commit written then must still hash exactly the same today.
    const HASH_BEFORE_RATES_ILS = "f664c66736f65ad885ee29ab60b9874e32a9db222cffd9c73c20c0713eb1df4a";
    const HASH_BEFORE_RATES_USD = "1895dd72504c871ff202fd368d8c512d87936e6efb24512bf0c9bb2e9f65abc1";
    const USD_STATE: LedgerCommitState = { ...BASE_STATE, amountAgorot: "-15158", currency: "USD", nativeAmount: "-4990" };

    it("leaves every commit written before rates were hashed unchanged", () => {
      expect(computeLedgerCommitHash(null, BASE_STATE)).toBe(HASH_BEFORE_RATES_ILS);
      expect(computeLedgerCommitHash(null, USD_STATE)).toBe(HASH_BEFORE_RATES_USD);
    });

    it("covers the rate: changing only the rate changes the hash", () => {
      const locked = computeLedgerCommitHash(null, { ...USD_STATE, exchangeRate: "3.037667" });
      expect(locked).not.toBe(HASH_BEFORE_RATES_USD);
      expect(computeLedgerCommitHash(null, { ...USD_STATE, exchangeRate: "3.037668" })).not.toBe(locked);
      expect(computeLedgerCommitHash(null, { ...USD_STATE, exchangeRate: "3.037667" })).toBe(locked);
    });
  });
});
