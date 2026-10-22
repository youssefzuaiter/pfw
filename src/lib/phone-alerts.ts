/**
 * What a nightly phone-alert check sends, and where it leaves off
 * (AGENTS.md §3qqq). Pure: the job gathers the facts, this decides.
 *
 * Five kinds of alert, most urgent first:
 *   - in-app notifications written since the last check (today, only the
 *     Emergency Vault's grace-period and triggered messages, §3t);
 *   - an envelope that went from not overdrawn to overdrawn;
 *   - a subscription or bill coming due within the next few days (once per
 *     due date, §3cccc);
 *   - an expense at or above the user's threshold that reached the ledger
 *     since the last check;
 *   - a reminder when no statement has been imported or synced for a while.
 *
 * Every alert is about something NEW, which is what the state is for: the
 * first check only records a starting point, an envelope alerts once when
 * it goes negative and again only after it recovers and goes negative
 * again, a bill reminds once per due date, and the import reminder repeats at
 * most weekly.
 */
export const LARGE_EXPENSES_LISTED = 5;
export const IMPORT_STALE_DAYS = 35;
export const IMPORT_REMINDER_EVERY_DAYS = 7;
/** A bill reminds this many days before it is due (and on the day itself if it comes into range later). */
export const BILL_REMINDER_DAYS = 3;
const MAX_LINES = 12;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type PhoneAlertState = {
  lastCheckedAt: Date | null;
  overdrawnCategoryIds: readonly string[];
  importReminderSentAt: Date | null;
  /** One `<bill key>|<due day>` per bill already reminded about and still inside the window, so each due date alerts once. */
  remindedBillKeys: readonly string[];
};

export type PhoneAlertFacts = {
  now: Date;
  /** In-app notification messages created after `lastCheckedAt`, oldest first. */
  notifications: readonly string[];
  /** Every envelope overdrawn right now, balances already formatted. */
  overdrawn: readonly { categoryId: string; name: string; balance: string }[];
  /**
   * Bills due within the next BILL_REMINDER_DAYS days and not yet paid, soonest
   * first. `key` identifies this bill on this due date, so tomorrow's check
   * does not repeat tonight's reminder; `due` is the day, `YYYY-MM-DD`.
   */
  billsDue: readonly { key: string; name: string; amount: string; due: string }[];
  /** New large expenses, largest first, at most LARGE_EXPENSES_LISTED of them. */
  largeExpenses: readonly { label: string; amount: string; day: string }[];
  /** How many new large expenses there are in total, listed or not. */
  largeExpenseCount: number;
  /** When the newest imported or synced row reached the ledger; null if none ever did. */
  lastImportAt: Date | null;
};

export type PhoneAlertKind = "notification" | "overdrawn" | "bill_due" | "large_expense" | "import_reminder";
export type PhoneAlertLine = { kind: PhoneAlertKind; text: string };

export type PhoneAlertEvaluation = { lines: PhoneAlertLine[]; nextState: PhoneAlertState };

export function evaluatePhoneAlerts(state: PhoneAlertState, facts: PhoneAlertFacts): PhoneAlertEvaluation {
  const overdrawnIds = facts.overdrawn.map((envelope) => envelope.categoryId);
  // Only the bills still inside the window are remembered: once a due date
  // passes, its key falls out, so the state cannot grow without bound.
  const billKeys = facts.billsDue.map((bill) => bill.key);
  if (state.lastCheckedAt === null) {
    return {
      lines: [],
      nextState: {
        lastCheckedAt: facts.now,
        overdrawnCategoryIds: overdrawnIds,
        importReminderSentAt: state.importReminderSentAt,
        remindedBillKeys: billKeys,
      },
    };
  }

  const lines: PhoneAlertLine[] = facts.notifications.map((text) => ({ kind: "notification", text }));

  const alreadyOverdrawn = new Set(state.overdrawnCategoryIds);
  for (const envelope of facts.overdrawn) {
    if (!alreadyOverdrawn.has(envelope.categoryId)) {
      lines.push({ kind: "overdrawn", text: `${envelope.name} is overdrawn: ${envelope.balance}` });
    }
  }

  const alreadyReminded = new Set(state.remindedBillKeys);
  for (const bill of facts.billsDue) {
    if (alreadyReminded.has(bill.key)) continue;
    // Amount BEFORE the name, for the same right-to-left reason as below.
    lines.push({ kind: "bill_due", text: `Bill due ${bill.due}: ${bill.amount} for ${bill.name}` });
  }

  for (const expense of facts.largeExpenses) {
    // Amount BEFORE the merchant, never after it. With a right-to-left name
    // (Hebrew, Arabic) in front of "-₪1,250.00", the phone reorders the minus
    // sign to the far side of the number and shows "₪1,250.00-". Seen on a
    // real phone; with the amount first, only the name is right-to-left and
    // the " at … on" around it keeps it from touching the figure.
    lines.push({ kind: "large_expense", text: `Large expense: ${expense.amount} at ${expense.label} on ${expense.day}` });
  }
  const unlisted = facts.largeExpenseCount - facts.largeExpenses.length;
  if (unlisted > 0) {
    lines.push({ kind: "large_expense", text: `…and ${unlisted} more large expense${unlisted === 1 ? "" : "s"}` });
  }

  let importReminderSentAt = state.importReminderSentAt;
  if (facts.lastImportAt) {
    const daysSinceImport = Math.floor((facts.now.getTime() - facts.lastImportAt.getTime()) / MS_PER_DAY);
    const remindedRecently =
      state.importReminderSentAt !== null &&
      facts.now.getTime() - state.importReminderSentAt.getTime() < IMPORT_REMINDER_EVERY_DAYS * MS_PER_DAY;
    if (daysSinceImport >= IMPORT_STALE_DAYS && !remindedRecently) {
      lines.push({
        kind: "import_reminder",
        text: `No statement imported for ${daysSinceImport} days. Import the latest one to keep budgets accurate.`,
      });
      importReminderSentAt = facts.now;
    }
  }

  return {
    lines,
    nextState: { lastCheckedAt: facts.now, overdrawnCategoryIds: overdrawnIds, importReminderSentAt, remindedBillKeys: billKeys },
  };
}

export type PhoneAlertMessage = { title: string; message: string; priority: 2 | 3 | 4; click: string };

const PRIORITY: Record<PhoneAlertKind, 2 | 3 | 4> = {
  notification: 4,
  overdrawn: 4,
  bill_due: 3,
  large_expense: 3,
  import_reminder: 2,
};

const SINGLE_TITLE: Record<PhoneAlertKind, string> = {
  notification: "PFW",
  overdrawn: "PFW: envelope overdrawn",
  bill_due: "PFW: bill due",
  large_expense: "PFW: large expense",
  import_reminder: "PFW: time to import",
};

/**
 * One notification for the whole night, so a busy day is one buzz. With
 * details off it says only how many alerts there are: no merchant, amount
 * or category passes through ntfy.sh or the phone's push service.
 */
export function composePhoneAlert(
  lines: readonly PhoneAlertLine[],
  options: { includeDetails: boolean; appUrl: string },
): PhoneAlertMessage | null {
  if (lines.length === 0) return null;
  const priority = Math.max(...lines.map((line) => PRIORITY[line.kind])) as 2 | 3 | 4;
  const click = `${options.appUrl}/dashboard`;

  if (!options.includeDetails) {
    const count = `${lines.length} new alert${lines.length === 1 ? "" : "s"}`;
    return { title: "PFW", message: `${count}. Details are hidden by your settings; open PFW to check.`, priority, click };
  }

  const title = lines.length === 1 ? SINGLE_TITLE[lines[0].kind] : `PFW: ${lines.length} alerts`;
  const shown = lines.slice(0, MAX_LINES).map((line) => line.text);
  if (lines.length > MAX_LINES) shown.push(`…and ${lines.length - MAX_LINES} more`);
  return { title, message: shown.join("\n"), priority, click };
}
