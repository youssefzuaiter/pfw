import { describe, expect, it, vi } from "vitest";
import { agorot } from "../../lib/money";
import { nativeAmount } from "../../lib/currency";
import type { PaperTradeReceiptInput } from "../dal/paper-trades";
import {
  recordPendingWithRaceTolerance,
  settleWithRaceRetry,
  type FindTradeFn,
  type RecordPendingFn,
  type SettleFn,
} from "./settle-with-race-retry";

const input: PaperTradeReceiptInput = {
  idempotencyKey: "race-key",
  orderId: "order-1",
  symbol: "TSLA",
  side: "BUY",
  quantity: 0.02,
  priceAgorot: agorot(108478),
  nativePriceAmount: nativeAmount(36491),
  currency: "USD",
  exchangeRate: 2.97274,
  executedAt: new Date("2026-09-16T17:15:23.700Z"),
  headline: "h",
};

const p2002 = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
const recorded = { status: "recorded" as const, tradeId: "t1", transactionId: "x1", categoryId: "c1", amountAgorot: agorot(-2345) };

describe("settleWithRaceRetry()", () => {
  it("retries once after a unique-constraint race and returns the settled result", async () => {
    const settle = vi.fn<SettleFn>().mockRejectedValueOnce(p2002).mockResolvedValueOnce(recorded);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await settleWithRaceRetry("u1", input, settle)).toEqual(recorded);
    expect(settle).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("raced its own pending receipt"));
    warn.mockRestore();
  });

  it("reports race_unresolved (a retryable 503 at the route) when the retry fails too, never a false duplicate", async () => {
    const settle = vi.fn<SettleFn>().mockRejectedValueOnce(p2002).mockRejectedValueOnce(new Error("still failing"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await settleWithRaceRetry("u1", input, settle)).toEqual({ status: "race_unresolved" });
    expect(settle).toHaveBeenCalledTimes(2);
    error.mockRestore();
    vi.restoreAllMocks();
  });

  it("rethrows anything that is not a unique-constraint violation without retrying", async () => {
    const settle = vi.fn<SettleFn>().mockRejectedValueOnce(new Error("connection reset"));
    await expect(settleWithRaceRetry("u1", input, settle)).rejects.toThrow("connection reset");
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("passes a first-try success straight through", async () => {
    const settle = vi.fn<SettleFn>().mockResolvedValueOnce({ status: "duplicate", tradeId: "t1" });
    expect(await settleWithRaceRetry("u1", input, settle)).toEqual({ status: "duplicate", tradeId: "t1" });
    expect(settle).toHaveBeenCalledTimes(1);
  });
});

describe("recordPendingWithRaceTolerance()", () => {
  const settledRow = { id: "t-settled" } as Awaited<ReturnType<FindTradeFn>>;

  it("resolves a pending insert that lost to an already-booked row as a duplicate (the CI-caught interleaving)", async () => {
    const recordPending = vi.fn<RecordPendingFn>().mockRejectedValueOnce(p2002);
    const findExisting = vi.fn<FindTradeFn>().mockResolvedValueOnce(settledRow);
    expect(await recordPendingWithRaceTolerance("u1", input, recordPending, findExisting)).toEqual({
      status: "duplicate",
      tradeId: "t-settled",
    });
    expect(findExisting).toHaveBeenCalledWith("u1", "race-key");
  });

  it("rethrows a unique-constraint error when no trade with that key can be found (not a race, a real fault)", async () => {
    const recordPending = vi.fn<RecordPendingFn>().mockRejectedValueOnce(p2002);
    const findExisting = vi.fn<FindTradeFn>().mockResolvedValueOnce(null);
    await expect(recordPendingWithRaceTolerance("u1", input, recordPending, findExisting)).rejects.toBe(p2002);
  });

  it("rethrows anything that is not a unique-constraint violation without looking anything up", async () => {
    const recordPending = vi.fn<RecordPendingFn>().mockRejectedValueOnce(new Error("connection reset"));
    const findExisting = vi.fn<FindTradeFn>();
    await expect(recordPendingWithRaceTolerance("u1", input, recordPending, findExisting)).rejects.toThrow("connection reset");
    expect(findExisting).not.toHaveBeenCalled();
  });

  it("passes a first-try success straight through", async () => {
    const recordPending = vi.fn<RecordPendingFn>().mockResolvedValueOnce({ status: "recorded", tradeId: "t1" });
    const findExisting = vi.fn<FindTradeFn>();
    expect(await recordPendingWithRaceTolerance("u1", input, recordPending, findExisting)).toEqual({ status: "recorded", tradeId: "t1" });
    expect(findExisting).not.toHaveBeenCalled();
  });
});
