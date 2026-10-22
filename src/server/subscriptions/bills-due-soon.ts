import "server-only";
import { billsDueWithin, type DueSoon } from "../../lib/bills-due-soon";
import { BILL_REMINDER_DAYS } from "../../lib/phone-alerts";
import { findPendingBills } from "../../lib/safe-to-spend";
import { getLatestRateTable } from "../dal/exchange-rates";
import { buildSubscriptionRadarData } from "./build-subscription-radar-data";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Bills coming due in the next few days: every recurring bill, the ones typed
 * in and the ones detected from statements alike, that is still to be charged.
 *
 * `findPendingBills` only sees one calendar month, so the radar is read twice,
 * as of today and as of the end of the window, and the two are merged. Within
 * one month the second read would be identical, so it is skipped.
 */
export async function listBillsDueSoon(userId: string, now: Date, withinDays: number = BILL_REMINDER_DAYS): Promise<DueSoon[]> {
  const later = new Date(now.getTime() + withinDays * MS_PER_DAY);
  const sameMonth = later.getUTCFullYear() === now.getUTCFullYear() && later.getUTCMonth() === now.getUTCMonth();

  const [radarNow, radarLater, rateTable] = await Promise.all([
    buildSubscriptionRadarData(userId, now),
    sameMonth ? Promise.resolve(null) : buildSubscriptionRadarData(userId, later),
    getLatestRateTable(now),
  ]);

  const lists = [findPendingBills(radarNow.subscriptions, now, rateTable)];
  if (radarLater) lists.push(findPendingBills(radarLater.subscriptions, later, rateTable));
  return billsDueWithin(lists, now, withinDays);
}
