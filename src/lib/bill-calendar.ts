import type { CurrencyCode } from "./currency";
import { formatMonthKey, monthKeyToExclusiveEndDate, monthKeyToStartDate, shiftMonthKey } from "./date-month";
import { utcDayKey } from "./fx-history";
import { dueDateInMonth } from "./recurring-bills";
import type { SubscriptionCadence } from "./subscription-radar";

/**
 * One month's calendar of what is charged, for ONE page (AGENTS.md §3gggg):
 * the Subscriptions page and the Bills page each draw their own. Pure: the
 * caller supplies the items and the charges already found in the ledger.
 *
 * A day shows two kinds of entry:
 *   - a charge that really happened (from the ledger), marked paid;
 *   - a charge still expected that month, from the item's schedule, marked
 *     due (today or later) or not charged yet (a date already past).
 *
 * Everything is UTC days, like the rest of the app, so the server and the
 * browser agree which day a charge falls on.
 */

export type CalendarItem = {
  key: string;
  name: string;
  currency: CurrencyCode;
  /** What one charge costs, positive, minor units of `currency`. */
  nativeAmount: number;
  schedule:
    | { kind: "anchor"; cadence: "monthly" | "quarterly" | "annual"; anchorDate: Date }
    | { kind: "seen"; cadence: SubscriptionCadence; lastSeenAt: Date; dueDay?: number; averageIntervalDays: number | null };
  /** A cancelled item has no expected charges, but charges it already had still show. */
  cancelled: boolean;
};

export type CalendarCharge = {
  itemKey: string;
  name: string;
  currency: CurrencyCode;
  /** Positive, minor units of `currency`. */
  nativeAmount: number;
  date: Date;
};

export type CalendarEntryState = "paid" | "due" | "not-charged";

export type CalendarEntry = {
  itemKey: string;
  name: string;
  currency: CurrencyCode;
  nativeAmount: number;
  state: CalendarEntryState;
};

export type CalendarDay = {
  /** `YYYY-MM-DD`. */
  date: string;
  day: number;
  isToday: boolean;
  entries: CalendarEntry[];
};

export type MonthCalendar = {
  monthKey: string;
  monthLabel: string;
  previousMonthKey: string;
  nextMonthKey: string;
  /** Empty cells before the 1st, for a week that starts on Monday. */
  leadingBlanks: number;
  days: CalendarDay[];
  counts: { paid: number; due: number; notCharged: number };
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MONTHS_BETWEEN: Record<Exclude<SubscriptionCadence, "weekly">, number> = { monthly: 1, quarterly: 3, annual: 12 };
/** A safety bound on stepping a weekly schedule through one month. */
const MAX_WEEKLY_STEPS = 400;

function daysInMonth(year: number, monthZeroBased: number): number {
  return new Date(Date.UTC(year, monthZeroBased + 1, 0)).getUTCDate();
}

function monthIndex(date: Date): number {
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

/**
 * The days an item is still expected to be charged in the given month,
 * ignoring whether it was already paid. A schedule seen in the statements is
 * only projected forward while the item still looks active: last charged
 * within one cycle of `today`. One that stopped is not shown as due forever.
 */
export function expectedDates(item: CalendarItem, year: number, monthZeroBased: number, today: Date): Date[] {
  if (item.cancelled) return [];

  const schedule = item.schedule;
  if (schedule.kind === "anchor") {
    const due = dueDateInMonth(schedule, year, monthZeroBased);
    return due ? [due] : [];
  }

  const monthStart = new Date(Date.UTC(year, monthZeroBased, 1));
  const monthEnd = new Date(Date.UTC(year, monthZeroBased + 1, 1));

  if (schedule.cadence === "weekly") {
    const interval = schedule.averageIntervalDays && schedule.averageIntervalDays > 0 ? schedule.averageIntervalDays : 7;
    if (today.getTime() - schedule.lastSeenAt.getTime() > (2 * interval + 3) * MS_PER_DAY) return [];
    const dates: Date[] = [];
    for (let step = 1; step <= MAX_WEEKLY_STEPS; step++) {
      const due = new Date(schedule.lastSeenAt.getTime() + step * interval * MS_PER_DAY);
      if (due >= monthEnd) break;
      if (due >= monthStart) dates.push(new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate())));
    }
    return dates;
  }

  const gap = MONTHS_BETWEEN[schedule.cadence];
  const stillActive = monthIndex(today) - monthIndex(schedule.lastSeenAt) <= gap;
  const ahead = year * 12 + monthZeroBased - monthIndex(schedule.lastSeenAt);
  if (!stillActive || ahead <= 0 || ahead % gap !== 0) return [];
  const day = Math.min(schedule.dueDay ?? schedule.lastSeenAt.getUTCDate(), daysInMonth(year, monthZeroBased));
  return [new Date(Date.UTC(year, monthZeroBased, day))];
}

export function buildMonthCalendar(input: {
  monthKey: string;
  items: readonly CalendarItem[];
  /** The ledger charges that belong to the items, any month; only this month's are used. */
  charges: readonly CalendarCharge[];
  today: Date;
}): MonthCalendar {
  const { monthKey, items, charges, today } = input;
  const start = monthKeyToStartDate(monthKey);
  const end = monthKeyToExclusiveEndDate(monthKey);
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  const todayKey = utcDayKey(today);

  const byDay = new Map<string, CalendarEntry[]>();
  const add = (date: Date, entry: CalendarEntry) => {
    const key = utcDayKey(date);
    const list = byDay.get(key) ?? [];
    list.push(entry);
    byDay.set(key, list);
  };

  const monthCharges = charges.filter((charge) => charge.date >= start && charge.date < end);
  for (const charge of monthCharges) {
    add(charge.date, { itemKey: charge.itemKey, name: charge.name, currency: charge.currency, nativeAmount: charge.nativeAmount, state: "paid" });
  }

  for (const item of items) {
    const itemCharges = monthCharges.filter((charge) => charge.itemKey === item.key);
    const latestCharge = itemCharges.reduce((latest, charge) => Math.max(latest, charge.date.getTime()), -Infinity);
    const weekly = item.schedule.kind === "seen" && item.schedule.cadence === "weekly";
    for (const due of expectedDates(item, year, month, today)) {
      // A charge already found this month settles a monthly, quarterly or yearly item.
      // A weekly one can charge again, so only dates after its latest charge are still expected.
      if (!weekly && itemCharges.length > 0) continue;
      if (weekly && due.getTime() <= latestCharge) continue;
      add(due, {
        itemKey: item.key,
        name: item.name,
        currency: item.currency,
        nativeAmount: item.nativeAmount,
        state: utcDayKey(due) >= todayKey ? "due" : "not-charged",
      });
    }
  }

  const counts = { paid: 0, due: 0, notCharged: 0 };
  const days: CalendarDay[] = [];
  for (let day = 1; day <= daysInMonth(year, month); day++) {
    const date = utcDayKey(new Date(Date.UTC(year, month, day)));
    const entries = (byDay.get(date) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.state === "paid") counts.paid++;
      else if (entry.state === "due") counts.due++;
      else counts.notCharged++;
    }
    days.push({ date, day, isToday: date === todayKey, entries });
  }

  return {
    monthKey,
    monthLabel: formatMonthKey(monthKey),
    previousMonthKey: shiftMonthKey(monthKey, -1),
    nextMonthKey: shiftMonthKey(monthKey, 1),
    leadingBlanks: (start.getUTCDay() + 6) % 7,
    days,
    counts,
  };
}
