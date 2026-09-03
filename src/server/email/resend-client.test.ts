import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "./resend-client";

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("sendEmail()", () => {
  const originalApiKey = process.env.RESEND_API_KEY;
  const originalFrom = process.env.RESEND_FROM_EMAIL;

  beforeEach(() => {
    process.env.RESEND_API_KEY = "test-resend-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalApiKey;
    if (originalFrom === undefined) delete process.env.RESEND_FROM_EMAIL;
    else process.env.RESEND_FROM_EMAIL = originalFrom;
  });

  it("posts to the Resend API with the auth header and correct body shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "abc" }));
    vi.stubGlobal("fetch", fetchMock);

    await sendEmail({ to: "user@example.com", subject: "Subject", html: "<p>hi</p>", text: "hi" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-resend-key");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ to: ["user@example.com"], subject: "Subject", html: "<p>hi</p>", text: "hi" });
  });

  it("uses the default onboarding sender when RESEND_FROM_EMAIL is unset", async () => {
    delete process.env.RESEND_FROM_EMAIL;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "abc" }));
    vi.stubGlobal("fetch", fetchMock);

    await sendEmail({ to: "user@example.com", subject: "s", html: "h", text: "t" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.from).toBe("PFW <onboarding@resend.dev>");
  });

  it("throws on a non-OK response, without leaking the response body into the error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: "sensitive detail" }, { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendEmail({ to: "user@example.com", subject: "s", html: "h", text: "t" })).rejects.toThrow(
      "Resend API request failed with status 422",
    );
  });

  it("throws when RESEND_API_KEY is unset, without ever calling fetch", async () => {
    delete process.env.RESEND_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendEmail({ to: "user@example.com", subject: "s", html: "h", text: "t" })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
