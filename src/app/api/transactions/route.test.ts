import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Manual entry in a chosen currency (AGENTS.md §3www): the route locks the
 * rate itself, computes the exact shekel figure, refuses a figure that
 * differs from the one the form showed, and stores the entered amount,
 * currency and rate alongside it. The guard, the account read, the rate
 * lookup and the write are mocked; each has its own tests.
 */
vi.mock("../../../server/api/guard-mutation", () => ({ guardMutation: vi.fn() }));
vi.mock("../../../server/dal/bank-accounts", () => ({ getBankAccountById: vi.fn() }));
vi.mock("../../../server/dal/audit-log", () => ({ recordAuditLog: vi.fn() }));
vi.mock("../../../server/dal/transactions", () => ({ createTransaction: vi.fn() }));
vi.mock("../../../server/currency/lock-rate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../server/currency/lock-rate")>()),
  lockRateFor: vi.fn(),
}));

import { POST } from "./route";
import { guardMutation } from "../../../server/api/guard-mutation";
import { getBankAccountById } from "../../../server/dal/bank-accounts";
import { createTransaction } from "../../../server/dal/transactions";
import { lockRateFor, NoRateForDayError } from "../../../server/currency/lock-rate";

const LOCKED_USD = { currency: "USD" as const, micros: 3_037_667, rate: "3.037667", rateDay: "2026-10-09", day: "2026-10-11" };

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(new NextRequest("http://localhost:3000/api/transactions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bankAccountId: "acc-1", occurredAt: "2026-10-11T00:00:00.000Z", description: "Books", ...body }),
  }));
}

describe("POST /api/transactions in a chosen currency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(guardMutation).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getBankAccountById).mockResolvedValue({ id: "acc-1", currency: "ILS" } as never);
    vi.mocked(lockRateFor).mockResolvedValue(LOCKED_USD);
    vi.mocked(createTransaction).mockImplementation(async (_userId, input) => ({
      id: "tx-1",
      occurredAt: new Date("2026-10-11T00:00:00.000Z"),
      amount: input.amountAgorot,
      currency: input.entered?.currency ?? "ILS",
      nativeAmount: input.entered?.nativeAmount ?? input.amountAgorot,
      categoryId: "cat-1",
      category: { name: "Books" },
      needsReview: false,
    }) as never);
  });

  it("locks the rate, stores the exact shekel figure, and records what was typed", async () => {
    const response = await post({ amount: "-49.90", currency: "USD", expectedAmountAgorot: "-15158" });
    expect(response.status).toBe(201);
    expect(lockRateFor).toHaveBeenCalledWith("USD", "2026-10-11T00:00:00.000Z");
    expect(vi.mocked(createTransaction).mock.calls[0][1]).toMatchObject({
      amountAgorot: -15_158n,
      entered: { currency: "USD", nativeAmount: -4_990n, exchangeRate: "3.037667" },
    });
    expect((await response.json()).transaction).toMatchObject({ currency: "USD", nativeAmount: -4_990, exchangeRate: "3.037667", rateDay: "2026-10-09" });
  });

  it("refuses with 409 when the figure the form showed is not the one the server computes", async () => {
    const response = await post({ amount: "-49.90", currency: "USD", expectedAmountAgorot: "-15157" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "rate_changed", amountAgorot: -15_158, rate: "3.037667" });
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("requires the previewed figure for a foreign amount", async () => {
    expect((await post({ amount: "-49.90", currency: "USD" })).status).toBe(400);
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("answers 422 when no rate is stored for the day, storing nothing", async () => {
    vi.mocked(lockRateFor).mockRejectedValue(new NoRateForDayError("USD", "2020-01-01"));
    const response = await post({ amount: "-49.90", currency: "USD", expectedAmountAgorot: "-15158" });
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe("no_rate_for_day");
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("defaults to the account's own currency", async () => {
    vi.mocked(getBankAccountById).mockResolvedValue({ id: "acc-1", currency: "TRY" } as never);
    vi.mocked(lockRateFor).mockResolvedValue({ currency: "TRY", micros: 62_267, rate: "0.062267", rateDay: "2026-10-09", day: "2026-10-11" });
    const response = await post({ amount: "-1234.56", expectedAmountAgorot: "-7687" });
    expect(response.status).toBe(201);
    expect(lockRateFor).toHaveBeenCalledWith("TRY", expect.any(String));
    expect(vi.mocked(createTransaction).mock.calls[0][1]).toMatchObject({ amountAgorot: -7_687n, entered: { currency: "TRY", nativeAmount: -123_456n } });
  });

  it("books shekels as before, with no rate and no previewed figure needed", async () => {
    const response = await post({ amount: "-₪125.50" });
    expect(response.status).toBe(201);
    expect(lockRateFor).not.toHaveBeenCalled();
    expect(vi.mocked(createTransaction).mock.calls[0][1]).toMatchObject({ amountAgorot: -12_550n, entered: undefined });
  });

  it("refuses an amount with more than two decimals, an unknown currency, and an amount too small to record", async () => {
    expect((await post({ amount: "-1.999", currency: "USD", expectedAmountAgorot: "-6" })).status).toBe(400);
    expect((await post({ amount: "-10", currency: "JPY", expectedAmountAgorot: "-1" })).status).toBe(400);
    vi.mocked(lockRateFor).mockResolvedValue({ currency: "TRY", micros: 62_267, rate: "0.062267", rateDay: "2026-10-09", day: "2026-10-11" });
    expect((await post({ amount: "-0.01", currency: "TRY", expectedAmountAgorot: "0" })).status).toBe(400);
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("answers 404 for an account that is not the caller's, before any rate is looked up", async () => {
    vi.mocked(getBankAccountById).mockResolvedValue(null);
    expect((await post({ amount: "-49.90", currency: "USD", expectedAmountAgorot: "-15158" })).status).toBe(404);
    expect(lockRateFor).not.toHaveBeenCalled();
  });
});
