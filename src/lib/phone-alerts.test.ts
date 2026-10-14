import { describe, expect, it } from "vitest";
import {
  composePhoneAlert,
  evaluatePhoneAlerts,
  IMPORT_REMINDER_EVERY_DAYS,
  IMPORT_STALE_DAYS,
  type PhoneAlertFacts,
  type PhoneAlertState,
} from "./phone-alerts";

const NOW = new Date("2026-10-13T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

const CHECKED: PhoneAlertState = { lastCheckedAt: daysAgo(1), overdrawnCategoryIds: [], importReminderSentAt: null };

function facts(overrides: Partial<PhoneAlertFacts> = {}): PhoneAlertFacts {
  return { now: NOW, notifications: [], overdrawn: [], largeExpenses: [], largeExpenseCount: 0, lastImportAt: null, ...overrides };
}

describe("evaluatePhoneAlerts", () => {
  it("only records a starting point on the first check, whatever is already true", () => {
    const result = evaluatePhoneAlerts(
      { lastCheckedAt: null, overdrawnCategoryIds: [], importReminderSentAt: null },
      facts({
        notifications: ["old"],
        overdrawn: [{ categoryId: "c1", name: "Dining", balance: "-₪50.00" }],
        largeExpenses: [{ label: "Rent", amount: "-₪4,000.00", day: "2026-10-01" }],
        largeExpenseCount: 1,
        lastImportAt: daysAgo(90),
      }),
    );
    expect(result.lines).toEqual([]);
    expect(result.nextState).toEqual({ lastCheckedAt: NOW, overdrawnCategoryIds: ["c1"], importReminderSentAt: null });
  });

  it("sends nothing on a quiet night but still moves the starting point", () => {
    const result = evaluatePhoneAlerts(CHECKED, facts());
    expect(result.lines).toEqual([]);
    expect(result.nextState.lastCheckedAt).toBe(NOW);
  });

  it("alerts an envelope once when it goes negative, not every night it stays there", () => {
    const dining = { categoryId: "c1", name: "Dining", balance: "-₪50.00" };
    const first = evaluatePhoneAlerts(CHECKED, facts({ overdrawn: [dining] }));
    expect(first.lines).toEqual([{ kind: "overdrawn", text: "Dining is overdrawn: -₪50.00" }]);

    const second = evaluatePhoneAlerts(first.nextState, facts({ overdrawn: [dining] }));
    expect(second.lines).toEqual([]);

    const recovered = evaluatePhoneAlerts(second.nextState, facts({ overdrawn: [] }));
    expect(recovered.nextState.overdrawnCategoryIds).toEqual([]);
    const again = evaluatePhoneAlerts(recovered.nextState, facts({ overdrawn: [dining] }));
    expect(again.lines).toHaveLength(1);
  });

  it("lists new large expenses and counts the ones it leaves out", () => {
    const result = evaluatePhoneAlerts(
      CHECKED,
      facts({ largeExpenses: [{ label: "MİGROS", amount: "-₺4,500.00", day: "2026-10-12" }], largeExpenseCount: 3 }),
    );
    expect(result.lines.map((line) => line.text)).toEqual([
      "Large expense: MİGROS -₺4,500.00 on 2026-10-12",
      "…and 2 more large expenses",
    ]);
    const one = evaluatePhoneAlerts(
      CHECKED,
      facts({ largeExpenses: [{ label: "A", amount: "-₪1", day: "d" }], largeExpenseCount: 2 }),
    );
    expect(one.lines[1].text).toBe("…and 1 more large expense");
  });

  it("forwards new in-app notifications first", () => {
    const result = evaluatePhoneAlerts(
      CHECKED,
      facts({
        notifications: ["Your Emergency Vault entered its grace period."],
        overdrawn: [{ categoryId: "c1", name: "Dining", balance: "-₪1.00" }],
      }),
    );
    expect(result.lines.map((line) => line.kind)).toEqual(["notification", "overdrawn"]);
  });

  it("reminds after IMPORT_STALE_DAYS without an import, then at most weekly", () => {
    expect(evaluatePhoneAlerts(CHECKED, facts({ lastImportAt: daysAgo(IMPORT_STALE_DAYS - 1) })).lines).toEqual([]);

    const due = evaluatePhoneAlerts(CHECKED, facts({ lastImportAt: daysAgo(IMPORT_STALE_DAYS) }));
    expect(due.lines).toEqual([
      { kind: "import_reminder", text: `No statement imported for ${IMPORT_STALE_DAYS} days. Import the latest one to keep budgets accurate.` },
    ]);
    expect(due.nextState.importReminderSentAt).toBe(NOW);

    const remindedJustUnderAWeekAgo = { ...CHECKED, importReminderSentAt: new Date(NOW.getTime() - IMPORT_REMINDER_EVERY_DAYS * DAY + 1) };
    expect(evaluatePhoneAlerts(remindedJustUnderAWeekAgo, facts({ lastImportAt: daysAgo(60) })).lines).toEqual([]);
    const remindedAWeekAgo = { ...CHECKED, importReminderSentAt: daysAgo(IMPORT_REMINDER_EVERY_DAYS) };
    expect(evaluatePhoneAlerts(remindedAWeekAgo, facts({ lastImportAt: daysAgo(60) })).lines).toHaveLength(1);
  });

  it("never reminds someone who has never imported, and keeps the old reminder time when not reminding", () => {
    const state = { ...CHECKED, importReminderSentAt: daysAgo(3) };
    const result = evaluatePhoneAlerts(state, facts({ lastImportAt: null }));
    expect(result.lines).toEqual([]);
    expect(result.nextState.importReminderSentAt).toEqual(daysAgo(3));
  });
});

describe("composePhoneAlert", () => {
  const APP = "https://pfw.example";

  it("sends nothing when there is nothing to say", () => {
    expect(composePhoneAlert([], { includeDetails: true, appUrl: APP })).toBeNull();
  });

  it("titles a single alert by its kind and links to the app", () => {
    expect(composePhoneAlert([{ kind: "overdrawn", text: "Dining is overdrawn: -₪50.00" }], { includeDetails: true, appUrl: APP })).toEqual({
      title: "PFW: envelope overdrawn",
      message: "Dining is overdrawn: -₪50.00",
      priority: 4,
      click: "https://pfw.example/dashboard",
    });
  });

  it("puts several alerts in one notification at the highest priority among them", () => {
    const message = composePhoneAlert(
      [
        { kind: "large_expense", text: "a" },
        { kind: "import_reminder", text: "b" },
      ],
      { includeDetails: true, appUrl: APP },
    );
    expect(message).toMatchObject({ title: "PFW: 2 alerts", message: "a\nb", priority: 3 });
  });

  it("caps a long night at twelve lines and says how many it left out", () => {
    const lines = Array.from({ length: 15 }, (_, i) => ({ kind: "large_expense" as const, text: `line ${i}` }));
    const message = composePhoneAlert(lines, { includeDetails: true, appUrl: APP });
    expect(message?.message.split("\n")).toHaveLength(13);
    expect(message?.message.endsWith("…and 3 more")).toBe(true);
  });

  it("with details off, says only how many alerts there are", () => {
    const message = composePhoneAlert(
      [
        { kind: "overdrawn", text: "Dining is overdrawn: -₪50.00" },
        { kind: "large_expense", text: "Large expense: MİGROS -₺4,500.00 on 2026-10-12" },
      ],
      { includeDetails: false, appUrl: APP },
    );
    expect(message).toEqual({
      title: "PFW",
      message: "2 new alerts. Details are hidden by your settings; open PFW to check.",
      priority: 4,
      click: "https://pfw.example/dashboard",
    });
    expect(JSON.stringify(message)).not.toMatch(/Dining|MİGROS|₪|₺/);
  });
});
