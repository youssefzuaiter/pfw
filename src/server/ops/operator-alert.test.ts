import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderOperatorAlert, sendOperatorAlert } from "./operator-alert";

describe("operator alerts", () => {
  // Both vars are captured and restored rather than just deleted: a
  // developer's own .env legitimately sets OPERATOR_ALERT_EMAIL (it is
  // what unlocks /settings/ops locally — see .env.example), and a test
  // that merely assumes it is unset passes or fails depending on whose
  // machine it runs on. Each case states the value it needs.
  const originalEnv = { operator: process.env.OPERATOR_ALERT_EMAIL, appUrl: process.env.APP_URL };

  beforeEach(() => {
    process.env.APP_URL = "https://pfw.example.test";
    delete process.env.OPERATOR_ALERT_EMAIL;
  });
  afterEach(() => {
    if (originalEnv.operator === undefined) delete process.env.OPERATOR_ALERT_EMAIL;
    else process.env.OPERATOR_ALERT_EMAIL = originalEnv.operator;
    if (originalEnv.appUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalEnv.appUrl;
    vi.restoreAllMocks();
  });

  it("is a no-op that reports 'not_configured' when OPERATOR_ALERT_EMAIL is unset — never a throw", async () => {
    const send = vi.fn();
    expect(await sendOperatorAlert({ subject: "x", lines: ["y"] }, send)).toBe("not_configured");
    expect(send).not.toHaveBeenCalled();
  });

  it("sends one email to the configured address with the [PFW] subject prefix and the deployment origin", async () => {
    process.env.OPERATOR_ALERT_EMAIL = "ops@example.test";
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await sendOperatorAlert({ subject: "cron: 2 job(s) failed", lines: ["fx-rate-sync: HTTP 503"] }, send)).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    const input = send.mock.calls[0][0];
    expect(input.to).toBe("ops@example.test");
    expect(input.subject).toBe("[PFW] cron: 2 job(s) failed");
    expect(input.text).toContain("fx-rate-sync: HTTP 503");
    expect(input.text).toContain("Deployment: https://pfw.example.test");
  });

  it("reports 'failed' instead of throwing when Resend rejects the send", async () => {
    process.env.OPERATOR_ALERT_EMAIL = "ops@example.test";
    const send = vi.fn().mockRejectedValue(new Error("Resend 500"));
    expect(await sendOperatorAlert({ subject: "x", lines: [] }, send)).toBe("failed");
  });

  it("HTML-escapes the body so an error message can never inject markup into the email", () => {
    const rendered = renderOperatorAlert({ subject: "x", lines: ['<script>alert("1")</script> & more'] });
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;");
    expect(rendered.text).toContain('<script>alert("1")</script>');
  });
});
