import { describe, expect, it, vi } from "vitest";
import { agorot } from "../../lib/money";
import { nativeAmount } from "../../lib/currency";
import type { PaperTradeReceiptInput } from "../dal/paper-trades";
import { settleWithRaceRetry, type SettleFn } from "./settle-with-race-retry";

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
