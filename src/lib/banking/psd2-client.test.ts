import { describe, expect, it } from "vitest";
import { parseDecimalToNativeAmount } from "../currency";
import {
  connectToInstitution,
  fetchTransactions,
  findMockInstitution,
  MOCK_INSTITUTIONS,
  Psd2ApiError,
  UnknownInstitutionError,
} from "./psd2-client";

/** Never triggers the simulated failure (0.5 is well above FAILURE_RATE) — a constant well under 1 also keeps the real simulated-latency `setTimeout` short rather than pinned to this module's own maximum, so these deterministic tests don't unnecessarily add real wall-clock time. */
function alwaysSucceedsRandom(): () => number {
  return () => 0.5;
}

/** Always triggers the simulated failure on its very first call (latency roll), or — for functions that roll latency then failure — the second call. Tests that need this pass explicit sequences instead where order matters. */
function alwaysFailsRandom(): () => number {
  return () => 0;
}

describe("findMockInstitution", () => {
  it("finds a known institution by id", () => {
    const first = MOCK_INSTITUTIONS[0];
    expect(findMockInstitution(first.id)).toEqual(first);
  });

  it("returns undefined for an unknown id", () => {
    expect(findMockInstitution("not-a-real-institution")).toBeUndefined();
  });
});

describe("connectToInstitution", () => {
  it("throws UnknownInstitutionError for an unrecognized institution id", async () => {
    await expect(connectToInstitution("not-a-real-institution", alwaysSucceedsRandom())).rejects.toThrow(UnknownInstitutionError);
  });

  it("returns a real-shaped result on success: a token, ~90-day expiry, and an account in the institution's own currency", async () => {
    const institution = MOCK_INSTITUTIONS[0];
    const before = Date.now();
    const result = await connectToInstitution(institution.id, alwaysSucceedsRandom());

    expect(result.accessToken).toMatch(/^mock_psd2_[0-9a-f]{48}$/);
    expect(result.account.currency).toBe(institution.currency);
    expect(result.account.iban.startsWith(institution.country)).toBe(true);

    const daysUntilExpiry = (result.expiresAt.getTime() - before) / (24 * 60 * 60 * 1000);
    expect(daysUntilExpiry).toBeGreaterThan(89);
    expect(daysUntilExpiry).toBeLessThan(91);
  });

  it("throws Psd2ApiError with a transient code when the simulated failure roll hits", async () => {
    const institution = MOCK_INSTITUTIONS[0];
    await expect(connectToInstitution(institution.id, alwaysFailsRandom())).rejects.toThrow(Psd2ApiError);
  });
});

describe("fetchTransactions", () => {
  it("throws UnknownInstitutionError for an unrecognized institution id", async () => {
    await expect(fetchTransactions("not-a-real-institution", new Date(0), alwaysSucceedsRandom())).rejects.toThrow(
      UnknownInstitutionError,
    );
  });

  it("throws Psd2ApiError when the simulated failure roll hits", async () => {
    const institution = MOCK_INSTITUTIONS[0];
    await expect(fetchTransactions(institution.id, new Date(0), alwaysFailsRandom())).rejects.toThrow(Psd2ApiError);
  });

  it("is deterministic: the same institution and `since` date return an identical transaction set across calls", async () => {
    const institution = MOCK_INSTITUTIONS[1];
    const since = new Date(0); // full history
    const first = await fetchTransactions(institution.id, since, alwaysSucceedsRandom());
    const second = await fetchTransactions(institution.id, since, alwaysSucceedsRandom());
    expect(second).toEqual(first);
  });

  it("filters strictly by bookingDate >= since, and a later `since` never returns more than an earlier one", async () => {
    const institution = MOCK_INSTITUTIONS[2];
    const farPast = new Date(0);
    const today = new Date();

    const fullHistory = await fetchTransactions(institution.id, farPast, alwaysSucceedsRandom());
    const recentOnly = await fetchTransactions(institution.id, today, alwaysSucceedsRandom());

    expect(recentOnly.length).toBeLessThanOrEqual(fullHistory.length);
    const todayKey = today.toISOString().slice(0, 10);
    for (const transaction of recentOnly) {
      expect(transaction.bookingDate >= todayKey).toBe(true);
    }
    for (const transaction of fullHistory) {
      expect(transaction.bookingDate >= farPast.toISOString().slice(0, 10)).toBe(true);
    }
  });

  it("a since date after all history returns an empty array, never an error", async () => {
    const institution = MOCK_INSTITUTIONS[0];
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    expect(await fetchTransactions(institution.id, farFuture, alwaysSucceedsRandom())).toEqual([]);
  });

  it("every generated amount is a valid, parseable negative decimal string in the institution's own currency", async () => {
    const institution = MOCK_INSTITUTIONS[3];
    const transactions = await fetchTransactions(institution.id, new Date(0), alwaysSucceedsRandom());
    expect(transactions.length).toBeGreaterThan(0); // 60 days of history at up to 2/day makes an all-zero draw astronomically unlikely, not flaky in practice

    for (const transaction of transactions) {
      expect(transaction.transactionAmount.currency).toBe(institution.currency);
      const parsed = parseDecimalToNativeAmount(transaction.transactionAmount.amount);
      expect(parsed).toBeLessThan(0); // this mock only generates expenses, matching this feature's own stated scope
      expect(transaction.transactionId).toContain(institution.id);
    }
  });
});
