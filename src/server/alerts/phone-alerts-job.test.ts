import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PhoneAlertFacts } from "../../lib/phone-alerts";
import type { PhoneAlertDelivery } from "../dal/phone-alerts";

vi.mock("../db/admin-client", () => ({ createAdminClient: vi.fn() }));
vi.mock("../dal/phone-alerts", () => ({ gatherPhoneAlertFacts: vi.fn(), getPhoneAlertDelivery: vi.fn(), savePhoneAlertState: vi.fn() }));
vi.mock("../env", () => ({ getAppUrl: () => "https://pfw.example", getOperatorAlertEmail: vi.fn() }));
vi.mock("./ntfy-client", () => ({ sendNtfy: vi.fn() }));

const { sendOperatorPhoneAlert, sendPhoneAlerts } = await import("./phone-alerts-job");

const NOW = new Date("2026-10-13T00:00:00Z");
const YESTERDAY = new Date("2026-10-12T00:00:00Z");

function delivery(overrides: Partial<PhoneAlertDelivery> = {}): PhoneAlertDelivery {
  return {
    topic: "pfw-topic-abcdef",
    largeExpenseAgorot: 100_000,
    includeDetails: true,
    state: { lastCheckedAt: YESTERDAY, overdrawnCategoryIds: [], importReminderSentAt: null },
    ...overrides,
  };
}

function facts(overrides: Partial<PhoneAlertFacts> = {}): PhoneAlertFacts {
  return { now: NOW, notifications: [], overdrawn: [], largeExpenses: [], largeExpenseCount: 0, lastImportAt: null, ...overrides };
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    listSubscribers: vi.fn().mockResolvedValue(["user-1"]),
    getDelivery: vi.fn().mockResolvedValue(delivery()),
    gather: vi.fn().mockResolvedValue(facts()),
    saveState: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({ ok: true }),
    appUrl: () => "https://pfw.example",
    ...overrides,
  };
}

const OVERDRAWN = facts({ overdrawn: [{ categoryId: "c1", name: "Dining", balance: "-₪50.00" }] });

describe("sendPhoneAlerts", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("sends one notification per user with something new, then saves where it left off", async () => {
    const d = deps({ gather: vi.fn().mockResolvedValue(OVERDRAWN) });
    expect(await sendPhoneAlerts(NOW, d)).toEqual({ ok: true, checked: 1, sent: 1, failed: 0 });

    expect(d.gather).toHaveBeenCalledWith("user-1", { since: YESTERDAY, now: NOW, largeExpenseAgorot: 100_000 });
    expect(d.send).toHaveBeenCalledWith("pfw-topic-abcdef", expect.objectContaining({ message: "Dining is overdrawn: -₪50.00" }));
    expect(d.saveState).toHaveBeenCalledWith("user-1", { lastCheckedAt: NOW, overdrawnCategoryIds: ["c1"], importReminderSentAt: null });
  });

  it("saves the new starting point without sending on a quiet night", async () => {
    const d = deps();
    expect(await sendPhoneAlerts(NOW, d)).toEqual({ ok: true, checked: 1, sent: 0, failed: 0 });
    expect(d.send).not.toHaveBeenCalled();
    expect(d.saveState).toHaveBeenCalledTimes(1);
  });

  it("keeps the old state when the send fails, so tomorrow repeats tonight's alerts", async () => {
    const d = deps({ gather: vi.fn().mockResolvedValue(OVERDRAWN), send: vi.fn().mockResolvedValue({ ok: false, error: "ntfy.sh answered 500" }) });
    expect(await sendPhoneAlerts(NOW, d)).toEqual({ ok: true, checked: 1, sent: 0, failed: 1 });
    expect(d.saveState).not.toHaveBeenCalled();
  });

  it("counts one user's failure and carries on with the next", async () => {
    const d = deps({
      listSubscribers: vi.fn().mockResolvedValue(["broken", "user-1"]),
      getDelivery: vi.fn().mockImplementation(async (id: string) => {
        if (id === "broken") throw new Error("db hiccup");
        return delivery();
      }),
      gather: vi.fn().mockResolvedValue(OVERDRAWN),
    });
    expect(await sendPhoneAlerts(NOW, d)).toEqual({ ok: true, checked: 2, sent: 1, failed: 1 });
  });

  it("skips a user who turned alerts off since the list was read", async () => {
    const d = deps({ getDelivery: vi.fn().mockResolvedValue(null) });
    expect(await sendPhoneAlerts(NOW, d)).toEqual({ ok: true, checked: 1, sent: 0, failed: 0 });
    expect(d.gather).not.toHaveBeenCalled();
  });

  it("respects the details switch", async () => {
    const d = deps({ getDelivery: vi.fn().mockResolvedValue(delivery({ includeDetails: false })), gather: vi.fn().mockResolvedValue(OVERDRAWN) });
    await sendPhoneAlerts(NOW, d);
    expect(JSON.stringify(d.send.mock.calls[0][1])).not.toContain("Dining");
  });

  it("fails as a whole only when the subscriber list cannot be read", async () => {
    const d = deps({ listSubscribers: vi.fn().mockRejectedValue(new Error("connection refused")) });
    expect(await sendPhoneAlerts(NOW, d)).toEqual({ ok: false, error: "connection refused" });
  });
});

describe("sendOperatorPhoneAlert", () => {
  function operatorDeps(overrides: Record<string, unknown> = {}) {
    return {
      operatorEmail: () => "ops@example.com",
      findUserIdByEmail: vi.fn().mockResolvedValue("user-ops"),
      getDelivery: vi.fn().mockResolvedValue(delivery()),
      send: vi.fn().mockResolvedValue({ ok: true }),
      appUrl: () => "https://pfw.example",
      ...overrides,
    };
  }

  it("sends the failure lines to the operator's own topic", async () => {
    const d = operatorDeps();
    expect(await sendOperatorPhoneAlert(["fxRateSync: down"], d)).toBe("sent");
    expect(d.findUserIdByEmail).toHaveBeenCalledWith("ops@example.com");
    expect(d.send).toHaveBeenCalledWith("pfw-topic-abcdef", {
      title: "PFW: cron failed",
      message: "1 nightly job failed\nfxRateSync: down",
      priority: 4,
      click: "https://pfw.example/settings/ops",
    });
  });

  it("is not configured without an operator address, an account, or alerts on that account", async () => {
    expect(await sendOperatorPhoneAlert(["x"], operatorDeps({ operatorEmail: () => null }))).toBe("not_configured");
    expect(await sendOperatorPhoneAlert(["x"], operatorDeps({ findUserIdByEmail: vi.fn().mockResolvedValue(null) }))).toBe("not_configured");
    expect(await sendOperatorPhoneAlert(["x"], operatorDeps({ getDelivery: vi.fn().mockResolvedValue(null) }))).toBe("not_configured");
  });

  it("hides the lines when details are off, and never throws", async () => {
    const d = operatorDeps({ getDelivery: vi.fn().mockResolvedValue(delivery({ includeDetails: false })) });
    await sendOperatorPhoneAlert(["fxRateSync: down", "b"], d);
    expect(d.send.mock.calls[0][1].message).toBe("2 nightly jobs failed. See the email or the Vercel logs.");

    expect(await sendOperatorPhoneAlert(["x"], operatorDeps({ findUserIdByEmail: vi.fn().mockRejectedValue(new Error("db")) }))).toBe("failed");
    expect(await sendOperatorPhoneAlert(["x"], operatorDeps({ send: vi.fn().mockResolvedValue({ ok: false, error: "429" }) }))).toBe("failed");
  });
});
