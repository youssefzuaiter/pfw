import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Re-stating an account's balance: what the route accepts and refuses. The
 * guard, the DAL and the audit log are mocked; the roll-forward itself is
 * covered against Postgres in tests/integration/safe-to-spend.test.ts.
 */
vi.mock("../../../../server/api/guard-mutation", () => ({ guardMutation: vi.fn() }));
vi.mock("../../../../server/dal/bank-accounts", () => ({ reconcileBankAccount: vi.fn() }));
vi.mock("../../../../server/dal/audit-log", () => ({ recordAuditLog: vi.fn() }));

import { PATCH } from "./route";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { reconcileBankAccount } from "../../../../server/dal/bank-accounts";

function call(body: unknown) {
  const request = new NextRequest("http://localhost:3000/api/bank-accounts/acct-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return PATCH(request, { params: Promise.resolve({ id: "acct-1" }) });
}

const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

describe("PATCH /api/bank-accounts/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(guardMutation).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(reconcileBankAccount).mockResolvedValue({ ok: true, id: "acct-1", nativeBalance: 123_450n, balanceAsOf: new Date() });
  });

  it("returns the guard's response untouched", async () => {
    const refused = new Response(null, { status: 403 });
    vi.mocked(guardMutation).mockResolvedValue({ response: refused } as never);
    expect(await call({ nativeBalance: "10", balanceAsOf: YESTERDAY })).toBe(refused);
    expect(reconcileBankAccount).not.toHaveBeenCalled();
  });

  it("restates the balance and the day", async () => {
    const response = await call({ nativeBalance: "1234.50", balanceAsOf: YESTERDAY });
    expect(response.status).toBe(200);
    expect(reconcileBankAccount).toHaveBeenCalledWith("user-1", "acct-1", {
      nativeBalance: 123_450n,
      balanceAsOf: new Date(`${YESTERDAY}T00:00:00.000Z`),
    });
  });

  it.each([
    ["no body fields", {}],
    ["a missing day", { nativeBalance: "10" }],
    ["a missing balance", { balanceAsOf: YESTERDAY }],
    ["a malformed day", { nativeBalance: "10", balanceAsOf: "10/10/2026" }],
    ["an impossible day", { nativeBalance: "10", balanceAsOf: "2026-02-30" }],
    ["a day in the future", { nativeBalance: "10", balanceAsOf: "2999-01-01" }],
    ["a negative balance", { nativeBalance: "-5", balanceAsOf: YESTERDAY }],
    ["a balance that is not a number", { nativeBalance: "lots", balanceAsOf: YESTERDAY }],
  ])("refuses %s with 400 and writes nothing", async (_label, body) => {
    expect((await call(body)).status).toBe(400);
    expect(reconcileBankAccount).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON", async () => {
    expect((await call("not json")).status).toBe(400);
  });

  it("answers 404 for an account that is not the user's", async () => {
    vi.mocked(reconcileBankAccount).mockResolvedValue({ ok: false, error: "not_found" });
    expect((await call({ nativeBalance: "10", balanceAsOf: YESTERDAY })).status).toBe(404);
  });
});
