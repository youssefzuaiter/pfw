import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The phone-alert routes' wiring (AGENTS.md §3qqq): what the topic must look
 * like, that a generated one is long and random, that it never reaches the
 * audit log, and that the test send reports ntfy.sh's answer. The guard, the
 * DAL, the audit log and the ntfy client are mocked; each has its own tests.
 */
vi.mock("../../../server/api/guard-mutation", () => ({ guardMutation: vi.fn() }));
vi.mock("../../../server/dal/audit-log", () => ({ recordAuditLog: vi.fn() }));
vi.mock("../../../server/dal/phone-alerts", () => ({
  enablePhoneAlerts: vi.fn(),
  updatePhoneAlertPreferences: vi.fn(),
  disablePhoneAlerts: vi.fn(),
  getPhoneAlertDelivery: vi.fn(),
}));
vi.mock("../../../server/alerts/ntfy-client", () => ({ sendNtfy: vi.fn() }));
vi.mock("../../../server/env", () => ({ getAppUrl: () => "https://pfw.example" }));

import { DELETE, PATCH, POST } from "./route";
import { POST as TEST_POST } from "./test/route";
import { guardMutation } from "../../../server/api/guard-mutation";
import { recordAuditLog } from "../../../server/dal/audit-log";
import { disablePhoneAlerts, enablePhoneAlerts, getPhoneAlertDelivery, updatePhoneAlertPreferences } from "../../../server/dal/phone-alerts";
import { sendNtfy } from "../../../server/alerts/ntfy-client";

function request(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/phone-alerts", {
    method,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

const SETTINGS = { topicHint: "…c123", largeExpenseAgorot: 100_000, includeDetails: true };

describe("POST /api/phone-alerts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(guardMutation).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(enablePhoneAlerts).mockImplementation(async (_userId, topic) => ({ ...SETTINGS, topicHint: `…${topic.slice(-4)}` }));
  });

  it("makes a long random topic when none is given, and returns it once", async () => {
    const first = await (await POST(request("POST"))).json();
    const second = await (await POST(request("POST", {}))).json();
    expect(first.topic).toMatch(/^pfw-[A-Za-z0-9_-]{20}$/);
    expect(second.topic).not.toBe(first.topic);
    expect(enablePhoneAlerts).toHaveBeenCalledWith("user-1", first.topic);
  });

  it("accepts a chosen topic or a pasted ntfy.sh link", async () => {
    const response = await POST(request("POST", { topic: "https://ntfy.sh/my-own-topic-2026" }));
    expect(response.status).toBe(201);
    expect(enablePhoneAlerts).toHaveBeenCalledWith("user-1", "my-own-topic-2026");
  });

  it("refuses a short topic, another server, or a body that is not JSON", async () => {
    for (const body of [{ topic: "short" }, { topic: "https://ntfy.example.com/my-own-topic-2026" }, "not json", { topic: 5 }]) {
      expect((await POST(request("POST", body))).status).toBe(400);
    }
    expect(enablePhoneAlerts).not.toHaveBeenCalled();
  });

  it("never writes the topic into the audit log", async () => {
    await POST(request("POST", { topic: "my-own-topic-2026" }));
    expect(JSON.stringify(vi.mocked(recordAuditLog).mock.calls)).not.toContain("my-own-topic-2026");
  });

  it("stops at the guard's answer", async () => {
    vi.mocked(guardMutation).mockResolvedValue({ response: new Response(null, { status: 403 }) } as never);
    expect((await POST(request("POST"))).status).toBe(403);
    expect(enablePhoneAlerts).not.toHaveBeenCalled();
  });
});

describe("PATCH and DELETE /api/phone-alerts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(guardMutation).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(updatePhoneAlertPreferences).mockResolvedValue(SETTINGS);
  });

  it("parses the threshold as shekels into agorot", async () => {
    const response = await PATCH(request("PATCH", { largeExpense: "2500.50", includeDetails: false }));
    expect(response.status).toBe(200);
    expect(updatePhoneAlertPreferences).toHaveBeenCalledWith("user-1", { largeExpenseAgorot: 250_050, includeDetails: false });
  });

  it("refuses an empty change, a malformed amount, or one out of range", async () => {
    for (const body of [{}, { largeExpense: "abc" }, { largeExpense: "0.99" }, { largeExpense: "10000000.01" }, { includeDetails: "yes" }]) {
      expect((await PATCH(request("PATCH", body))).status).toBe(400);
    }
    expect(updatePhoneAlertPreferences).not.toHaveBeenCalled();
  });

  it("is a 404 when alerts are off", async () => {
    vi.mocked(updatePhoneAlertPreferences).mockResolvedValue(null);
    expect((await PATCH(request("PATCH", { includeDetails: true }))).status).toBe(404);
    vi.mocked(disablePhoneAlerts).mockResolvedValue(false);
    expect((await DELETE(request("DELETE"))).status).toBe(404);
  });

  it("turns alerts off", async () => {
    vi.mocked(disablePhoneAlerts).mockResolvedValue(true);
    expect((await DELETE(request("DELETE"))).status).toBe(200);
    expect(disablePhoneAlerts).toHaveBeenCalledWith("user-1");
  });
});

describe("POST /api/phone-alerts/test", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(guardMutation).mockResolvedValue({ user: { id: "user-1" } } as never);
  });

  it("sends one test notification to the user's own topic", async () => {
    vi.mocked(getPhoneAlertDelivery).mockResolvedValue({ topic: "my-own-topic-2026" } as never);
    vi.mocked(sendNtfy).mockResolvedValue({ ok: true });
    expect((await TEST_POST(request("POST"))).status).toBe(200);
    expect(vi.mocked(sendNtfy).mock.calls[0][0]).toBe("my-own-topic-2026");
    expect(vi.mocked(sendNtfy).mock.calls[0][1]).toMatchObject({ title: "PFW: test alert", click: "https://pfw.example/settings" });
  });

  it("is a 404 when alerts are off, and a 502 with ntfy's reason when the send fails", async () => {
    vi.mocked(getPhoneAlertDelivery).mockResolvedValue(null);
    expect((await TEST_POST(request("POST"))).status).toBe(404);

    vi.mocked(getPhoneAlertDelivery).mockResolvedValue({ topic: "my-own-topic-2026" } as never);
    vi.mocked(sendNtfy).mockResolvedValue({ ok: false, error: "ntfy.sh answered 500" });
    const response = await TEST_POST(request("POST"));
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe("The test alert was not delivered: ntfy.sh answered 500.");
  });
});
