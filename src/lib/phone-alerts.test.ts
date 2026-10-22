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

const CHECKED: PhoneAlertState = { lastCheckedAt: daysAgo(1), overdrawnCategoryIds: [], importReminderSentAt: null, remindedBillKeys: [] };

function facts(overrides: Partial<PhoneAlertFacts> = {}): PhoneAlertFacts {
  return { now: NOW, notifications: [], overdrawn: [], billsDue: [], largeExpenses: [], largeExpenseCount: 0, lastImportAt: null, ...overrides };
}

describe("evaluatePhoneAlerts", () => {
  it("only records a starting point on the first check, whatever is already true", () => {
    const result = evaluatePhoneAlerts(
      { lastCheckedAt: null, overdrawnCategoryIds: [], importReminderSentAt: null, remindedBillKeys: [] },
      facts({
        notifications: ["old"],
        billsDue: [{ key: "rent|2026-10-14", name: "Rent", amount: "₪4,000.00", due: "2026-10-14" }],
        overdrawn: [{ categoryId: "c1", name: "Dining", balance: "-₪50.00" }],
        largeExpenses: [{ label: "Rent", amount: "-₪4,000.00", day: "2026-10-01" }],
        largeExpenseCount: 1,
        lastImportAt: daysAgo(90),
      }),
    );
    expect(result.lines).toEqual([]);
    // The bill already in the window is remembered, so the first real check does not announce it.
    expect(result.nextState).toEqual({ lastCheckedAt: NOW, overdrawnCategoryIds: ["c1"], importReminderSentAt: null, remindedBillKeys: ["rent|2026-10-14"] });
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
      "Large expense: -₺4,500.00 at MİGROS on 2026-10-12",
      "…and 2 more large expenses",
    ]);
    const one = evaluatePhoneAlerts(
      CHECKED,
      facts({ largeExpenses: [{ label: "A", amount: "-₪1", day: "d" }], largeExpenseCount: 2 }),
    );
    expect(one.lines[1].text).toBe("…and 1 more large expense");
  });

  it("never puts a right-to-left merchant name next to the amount (the minus sign would swap sides on a phone)", () => {
    const result = evaluatePhoneAlerts(
      CHECKED,
      facts({ largeExpenses: [{ label: "קפה קפה", amount: "-₪1,250.00", day: "2026-10-13" }], largeExpenseCount: 1 }),
    );
    const text = result.lines[0].text;
    expect(text).toBe("Large expense: -₪1,250.00 at קפה קפה on 2026-10-13");
    const amountAt = text.indexOf("-₪1,250.00");
    expect(text.slice(0, amountAt)).not.toMatch(/[\u0590-\u08FF]/); // nothing right-to-left before the amount
    expect(text.slice(amountAt, amountAt + "-₪1,250.00 at".length)).toBe("-₪1,250.00 at"); // and a left-to-right word after it
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
        { kind: "large_expense", text: "Large expense: -₺4,500.00 at MİGROS on 2026-10-12" },
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

describe("bill reminders", () => {
  const rent = { key: "manual:r1|2026-10-17", name: "Rent", amount: "₪4,000.00", due: "2026-10-17" };
  const netflix = { key: "manual:n1|2026-10-18", name: "Netflix", amount: "₪49.90", due: "2026-10-18" };

  it("announces a bill that has come into the window, with the amount before the name", () => {
    const result = evaluatePhoneAlerts(CHECKED, facts({ billsDue: [rent] }));
    expect(result.lines).toEqual([{ kind: "bill_due", text: "Bill due 2026-10-17: ₪4,000.00 for Rent" }]);
    expect(result.nextState.remindedBillKeys).toEqual([rent.key]);
  });

  it("does not announce the same bill on the same due date twice", () => {
    const state = { ...CHECKED, remindedBillKeys: [rent.key] };
    const result = evaluatePhoneAlerts(state, facts({ billsDue: [rent] }));
    expect(result.lines).toEqual([]);
    expect(result.nextState.remindedBillKeys).toEqual([rent.key]);
  });

  it("announces only the new bill when another is already known", () => {
    const state = { ...CHECKED, remindedBillKeys: [rent.key] };
    const result = evaluatePhoneAlerts(state, facts({ billsDue: [rent, netflix] }));
    expect(result.lines.map((line) => line.text)).toEqual(["Bill due 2026-10-18: ₪49.90 for Netflix"]);
    expect(result.nextState.remindedBillKeys).toEqual([rent.key, netflix.key]);
  });

  it("forgets a bill once its date has left the window, so the next cycle announces again", () => {
    const afterPaying = evaluatePhoneAlerts({ ...CHECKED, remindedBillKeys: [rent.key] }, facts({ billsDue: [] }));
    expect(afterPaying.nextState.remindedBillKeys).toEqual([]);
    // A month later the same bill has a new due date, so a new key.
    const nextMonth = { ...rent, key: "manual:r1|2026-11-17", due: "2026-11-17" };
    expect(evaluatePhoneAlerts(afterPaying.nextState, facts({ billsDue: [nextMonth] })).lines).toHaveLength(1);
  });

  it("puts a bill after envelopes and before large expenses", () => {
    const result = evaluatePhoneAlerts(
      CHECKED,
      facts({
        overdrawn: [{ categoryId: "c1", name: "Dining", balance: "-₪50.00" }],
        billsDue: [rent],
        largeExpenses: [{ label: "Shop", amount: "-₪1,500.00", day: "2026-10-14" }],
        largeExpenseCount: 1,
      }),
    );
    expect(result.lines.map((line) => line.kind)).toEqual(["overdrawn", "bill_due", "large_expense"]);
  });

  it("is a normal-priority notification with its own title", () => {
    const lines = evaluatePhoneAlerts(CHECKED, facts({ billsDue: [rent] })).lines;
    const message = composePhoneAlert(lines, { includeDetails: true, appUrl: "https://pfw.test" });
    expect(message).toMatchObject({ title: "PFW: bill due", priority: 3 });
    expect(message?.message).toBe("Bill due 2026-10-17: ₪4,000.00 for Rent");
  });

  it("says only how many alerts there are when details are hidden", () => {
    const lines = evaluatePhoneAlerts(CHECKED, facts({ billsDue: [rent, netflix] })).lines;
    const message = composePhoneAlert(lines, { includeDetails: false, appUrl: "https://pfw.test" });
    expect(message?.message).not.toContain("Rent");
    expect(message?.message).not.toContain("₪");
    expect(message?.message).toContain("2 new alerts");
  });

  it("never puts a right-to-left name in front of the amount", () => {
    const hebrew = { key: "manual:h1|2026-10-17", name: "קפה קפה", amount: "₪4,000.00", due: "2026-10-17" };
    const text = evaluatePhoneAlerts(CHECKED, facts({ billsDue: [hebrew] })).lines[0].text;
    expect(text.indexOf("₪4,000.00")).toBeLessThan(text.indexOf("קפה"));
  });
});
