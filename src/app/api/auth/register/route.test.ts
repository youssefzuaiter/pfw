import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The sign-up switch (REGISTRATION_OPEN, env.ts) at the route itself.
 * Account creation, the email and the rate limiter are mocked: what is
 * under test is whether the route lets a request through to them at all.
 * `registerUser` has its own integration suite against real Postgres
 * (tests/integration/auth-credentials.test.ts).
 */
vi.mock("../../../../server/auth/credentials", () => ({ registerUser: vi.fn() }));
vi.mock("../../../../server/auth/email-verification", () => ({ sendEmailVerification: vi.fn() }));
vi.mock("../../../../server/api/rate-limit", () => ({ checkRateLimit: vi.fn() }));

import { POST } from "./route";
import { registerUser } from "../../../../server/auth/credentials";
import { sendEmailVerification } from "../../../../server/auth/email-verification";
import { checkRateLimit } from "../../../../server/api/rate-limit";

const BODY = { email: "New.Person@Example.com", password: "a-long-enough-password", displayName: "New Person" };

function request(origin = "http://localhost:3000"): NextRequest {
  return new NextRequest("http://localhost:3000/api/auth/register", {
    method: "POST",
    headers: { host: "localhost:3000", origin, "content-type": "application/json" },
    body: JSON.stringify(BODY),
  });
}

describe("POST /api/auth/register", () => {
  const original = process.env.REGISTRATION_OPEN;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, resetAt: 0 } as never);
    vi.mocked(registerUser).mockResolvedValue({ ok: true, userId: "user-1", inherited: false } as never);
    vi.mocked(sendEmailVerification).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    if (original === undefined) delete process.env.REGISTRATION_OPEN;
    else process.env.REGISTRATION_OPEN = original;
  });

  it("refuses when sign-up is closed (the default), before parsing, rate limiting or creating anything", async () => {
    delete process.env.REGISTRATION_OPEN;

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Registration is closed." });
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(registerUser).not.toHaveBeenCalled();
    expect(sendEmailVerification).not.toHaveBeenCalled();
  });

  it("stays closed for a look-alike value", async () => {
    process.env.REGISTRATION_OPEN = "TRUE";

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(registerUser).not.toHaveBeenCalled();
  });

  it("creates the account when sign-up is open", async () => {
    process.env.REGISTRATION_OPEN = "true";

    const response = await POST(request());

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, inherited: false });
    expect(registerUser).toHaveBeenCalledWith("new.person@example.com", BODY.password, "New Person");
    expect(sendEmailVerification).toHaveBeenCalledWith("user-1", "new.person@example.com");
  });

  it("still refuses a forged origin when sign-up is open", async () => {
    process.env.REGISTRATION_OPEN = "true";

    const response = await POST(request("https://evil.example"));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Origin mismatch" });
    expect(registerUser).not.toHaveBeenCalled();
  });
});
