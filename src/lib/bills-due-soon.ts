import type { Agorot } from "./money";
import type { PendingBill } from "./safe-to-spend";

/**
 * Which pending bills are coming up in the next few days, for the reminder
 * (AGENTS.md §3cccc). `findPendingBills` only looks inside one calendar month,
 * so a bill due on the 2nd is invisible on the 30th; the caller runs it for
 * today and again for the end of the window and this merges the two.
 *
 * Only bills due from today to `withinDays` days ahead are included. A bill
 * whose date has already passed unpaid is not reminded about: it is not news,
 * and a bill the user paid from outside the app would otherwise nag.
 */
export type DueSoon = {
  /** Identifies this bill on this due date, so a reminder is sent once per cycle. */
  key: string;
  merchantKey: string;
  name: string;
  amountAgorot: Agorot;
  /** The due day, `YYYY-MM-DD`. */
  due: string;
  daysAway: number;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function billsDueWithin(lists: readonly (readonly PendingBill[])[], asOf: Date, withinDays: number): DueSoon[] {
  const today = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  const last = today + withinDays * MS_PER_DAY;
  const found = new Map<string, DueSoon>();

  for (const pending of lists) {
    for (const bill of pending) {
      const due = Date.UTC(bill.dueDate.getUTCFullYear(), bill.dueDate.getUTCMonth(), bill.dueDate.getUTCDate());
      if (due < today || due > last) continue;
      const key = `${bill.merchantKey}|${dayOf(bill.dueDate)}`;
      if (found.has(key)) continue;
      found.set(key, {
        key,
        merchantKey: bill.merchantKey,
        name: bill.displayName,
        amountAgorot: bill.amountEachAgorot,
        due: dayOf(bill.dueDate),
        daysAway: Math.round((due - today) / MS_PER_DAY),
      });
    }
  }

  return [...found.values()].sort((a, b) => a.due.localeCompare(b.due) || a.name.localeCompare(b.name));
}
