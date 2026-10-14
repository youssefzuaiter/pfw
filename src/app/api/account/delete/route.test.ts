import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The account-deletion route's gates (AGENTS.md §3ttt): what it takes to
 * reach deleteAccount at all. The guard, the credential checks, the
 * protected-account check and the deletion itself are mocked; the deletion
 * runs for real against Postgres in tests/integration/account-deletion.test.ts.
 */
vi.mock("../../../../server/api/guard-mutation", () => ({ guardMutation: vi.fn() }));
vi.mock("../../../../server/auth/credentials", () => ({ verifyCredentials: vi.fn(), checkTotpChallenge: vi.fn() }));
vi.mock("../../../../server/account/delete-account", () => ({ deleteAccount: vi.fn() }));
vi.mock("../../../../server/account/protected-accounts", () => ({ whyAccountCannotBeDeleted: vi.fn() }));

import { POST } from "./route";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { checkTotpChallenge, verifyCredentials } from "../../../../server/auth/credentials";
import { deleteAccount } from "../../../../server/account/delete-account";
import { whyAccountCannotBeDeleted } from "../../../../server/account/protected-accounts";

const USER = { id: "user-1", email: "owner@example.com" };
const VALID = { password: "correct horse", confirm: "DELETE" };

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/account/delete", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/account/delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(guardMutation).mockResolvedValue({ user: USER } as never);
    vi.mocked(whyAccountCannotBeDeleted).mockResolvedValue(null);
    vi.mocked(verifyCredentials).mockResolvedValue({ outcome: "valid", user: { ...USER, displayName: "Owner", tokenVersion: 1 } });
    vi.mocked(checkTotpChallenge).mockResolvedValue("not_required");
    vi.mocked(deleteAccount).mockResolvedValue({ ok: true });
  });

  it("deletes the signed-in account with the password and the word DELETE", async () => {
    const response = await POST(request(VALID));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(verifyCredentials).toHaveBeenCalledWith(USER.email, "correct horse");
    expect(deleteAccount).toHaveBeenCalledWith(USER.id);
  });

  it("returns the guard's response untouched (origin, session, rate limit)", async () => {
    vi.mocked(guardMutation).mockResolvedValue({ response: new Response(null, { status: 403 }) } as never);
    expect((await POST(request(VALID))).status).toBe(403);
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it("refuses without the exact confirmation word, a password, or a JSON body", async () => {
    for (const body of [{ password: "x", confirm: "delete" }, { password: "x" }, { confirm: "DELETE" }, { password: "", confirm: "DELETE" }, "not json"]) {
      expect((await POST(request(body))).status).toBe(400);
    }
    expect(verifyCredentials).not.toHaveBeenCalled();
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it("refuses a wrong password, a locked account, or a password for another account", async () => {
    for (const outcome of [
      { outcome: "invalid" as const },
      { outcome: "locked" as const },
      { outcome: "valid" as const, user: { id: "someone-else", email: USER.email, displayName: "x", tokenVersion: 1 } },
    ]) {
      vi.mocked(verifyCredentials).mockResolvedValueOnce(outcome);
      const response = await POST(request(VALID));
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("invalid_password");
    }
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it("asks for the authenticator code when two-factor sign-in is on, and refuses a wrong one", async () => {
    vi.mocked(checkTotpChallenge).mockResolvedValueOnce("required");
    expect((await (await POST(request(VALID))).json()).code).toBe("totp_required");

    vi.mocked(checkTotpChallenge).mockResolvedValueOnce("invalid");
    expect((await (await POST(request({ ...VALID, totpCode: "000000" }))).json()).code).toBe("totp_invalid");
    expect(checkTotpChallenge).toHaveBeenLastCalledWith(USER.id, "000000");
    expect(deleteAccount).not.toHaveBeenCalled();

    vi.mocked(checkTotpChallenge).mockResolvedValueOnce("valid");
    expect((await POST(request({ ...VALID, totpCode: "123456" }))).status).toBe(200);
  });

  it("refuses a protected account before checking the password", async () => {
    vi.mocked(whyAccountCannotBeDeleted).mockResolvedValue("This account receives the paper trader's trades.");
    const response = await POST(request(VALID));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("protected_account");
    expect(verifyCredentials).not.toHaveBeenCalled();
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it("reports a refusal from the deletion itself, and a vanished account", async () => {
    vi.mocked(deleteAccount).mockResolvedValueOnce({ ok: false, error: "cross_tenant_reference", references: ["NotableTransaction.categoryId"] });
    const refused = await POST(request(VALID));
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("cross_tenant_reference");

    vi.mocked(deleteAccount).mockResolvedValueOnce({ ok: false, error: "not_found" });
    expect((await POST(request(VALID))).status).toBe(404);
  });

  it("answers 500 without details when the deletion throws", async () => {
    vi.mocked(deleteAccount).mockRejectedValueOnce(new Error("connection lost"));
    const response = await POST(request(VALID));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("connection lost");
  });
});
