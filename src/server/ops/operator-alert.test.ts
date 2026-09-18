import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderOperatorAlert, sendOperatorAlert } from "./operator-alert";

describe("operator alerts", () => {
  beforeEach(() => {
    process.env.APP_URL = "https://pfw.example.test";
  });
  afterEach(() => {
    delete process.env.OPERATOR_ALERT_EMAIL;
    delete process.env.APP_URL;
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
