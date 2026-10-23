import "server-only";
import { buildMonthCalendar, type CalendarCharge, type CalendarItem, type MonthCalendar } from "../../lib/bill-calendar";
import { monthKeyFor, monthKeyToExclusiveEndDate, monthKeyToStartDate } from "../../lib/date-month";
import { chargesInPeriod, type LedgerExpense, type RecurringBillKind } from "../../lib/recurring-bills";
import { listRecurringBills } from "../dal/recurring-bills";
import { getTransactionOccurrencesSince } from "../dal/transactions";
import { buildSubscriptionRadarData } from "./build-subscription-radar-data";

/**
 * One page's calendar for one month (AGENTS.md §3gggg). The Subscriptions page
 * draws the subscriptions the radar found plus the ones added by hand; the
 * Bills page draws only the bills added by hand, so neither shows the other's.
 *
 * Expected charges come from each item's schedule, and charges that really
 * happened come from the ledger by the day the money left: a detected
 * subscription's own charges (through the radar's merchant grouping) and, for
 * an item added by hand, the ledger expenses matching its name and amount.
 */
export async function buildRecurringCalendar(
  userId: string,
  kind: RecurringBillKind,
  monthKey: string,
  asOf: Date = new Date(),
): Promise<MonthCalendar> {
  const [radar, bills, occurrenceRows] = await Promise.all([
    buildSubscriptionRadarData(userId, asOf),
    listRecurringBills(userId),
    getTransactionOccurrencesSince(userId, monthKeyToStartDate(monthKey)),
  ]);

  const start = monthKeyToStartDate(monthKey);
  const end = monthKeyToExclusiveEndDate(monthKey);
  const expenses = occurrenceRows.filter((row) => row.nativeAmount < 0n && row.occurredAt >= start && row.occurredAt < end);

  const items: CalendarItem[] = [];
  const charges: CalendarCharge[] = [];

  if (kind === "subscription") {
    for (const row of radar.subscriptions) {
      if (row.manualBillId || !row.isRecurring || row.cadence === null || !row.memberMerchantKeys) continue;
      const key = row.merchantKey;
      items.push({
        key,
        name: row.displayName,
        currency: row.currency,
        nativeAmount: Math.abs(Number(row.currentNativeAmount)),
        schedule: { kind: "seen", cadence: row.cadence, lastSeenAt: row.lastSeenAt, dueDay: row.dueDay, averageIntervalDays: row.averageIntervalDays },
        cancelled: row.status === "CANCELLED",
      });
      const members = new Set(row.memberMerchantKeys);
      for (const charge of expenses) {
        if (charge.currency !== row.currency || !members.has(charge.merchantKey)) continue;
        charges.push({ itemKey: key, name: charge.displayName, currency: charge.currency, nativeAmount: Math.abs(Number(charge.nativeAmount)), date: charge.occurredAt });
      }
    }
  }

  // Items added by hand. One the radar has since detected from statements is left out here
  // (the detected one is drawn instead), so nothing appears twice.
  const ledger: LedgerExpense[] = expenses.map((row) => ({
    displayName: row.displayName,
    currency: row.currency,
    nativeAmount: Number(row.nativeAmount),
    occurredAt: row.occurredAt,
  }));
  const summaries = new Map(radar.manualBills.map((bill) => [bill.id, bill]));
  for (const bill of bills) {
    const summary = summaries.get(bill.id);
    if (bill.kind !== kind || !summary || summary.detectedAs) continue;
    const key = `manual:${bill.id}`;
    items.push({
      key,
      name: bill.name,
      currency: bill.currency,
      nativeAmount: bill.nativeAmount,
      schedule: { kind: "anchor", cadence: bill.cadence, anchorDate: bill.anchorDate },
      cancelled: summary.status === "CANCELLED",
    });
    for (const charge of chargesInPeriod(bill, ledger, start, end)) {
      charges.push({ itemKey: key, name: charge.displayName, currency: charge.currency, nativeAmount: Math.abs(charge.nativeAmount), date: charge.occurredAt });
    }
  }

  return buildMonthCalendar({ monthKey, items, charges, today: asOf });
}

/** The month the page opens on: the one asked for in the address when it is a real month, otherwise this one. */
export function resolveCalendarMonth(requested: string | undefined, asOf: Date = new Date()): string {
  return requested && /^\d{4}-(0[1-9]|1[0-2])$/.test(requested) ? requested : monthKeyFor(asOf);
}

