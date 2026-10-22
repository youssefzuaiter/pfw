import { nativeAmount, type CurrencyCode } from "./currency";
import { normalizeMerchantForFuzzyMatch, similarityRatio, type SubscriptionAnalysis, type SubscriptionCadence } from "./subscription-radar";

/**
 * Subscriptions and bills the user typed in (AGENTS.md §3cccc), turned into
 * the same rows the radar produces for detected ones, so Safe to Spend, the
 * cost totals and the subscriptions page need no separate path for them.
 *
 * A manual bill is a SCHEDULE: an anchor date and a cadence. Every due date is
 * derived (calendar months, so the 31st falls on the 28th in February), so a
 * schedule never goes stale. Whether this month's charge has already landed is
 * worked out from the ledger, never stored.
 *
 * Two ways a manual bill must not be counted twice:
 *   - once the radar has detected the same subscription from statements, the
 *     detected one takes over;
 *   - once this cycle's charge has appeared in the ledger, the bill is paid
 *     and no longer pending.
 *
 * Pure: the caller supplies already-fetched rows.
 */

export type RecurringBillInput = {
  id: string;
  name: string;
  /** What one charge costs, positive, in minor units of `currency`. */
  nativeAmount: number;
  currency: CurrencyCode;
  cadence: SubscriptionCadence & ("monthly" | "quarterly" | "annual");
  /** A date the bill is or was due (midnight UTC). */
  anchorDate: Date;
  categoryId: string | null;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MONTHS_PER_STEP = { monthly: 1, quarterly: 3, annual: 12 } as const;

/** The key a manual bill is tracked under in `SubscriptionTracking` (cancel, review). */
export function manualBillKey(id: string): string {
  return `manual:${id}`;
}

export function isManualBillKey(key: string): boolean {
  return key.startsWith("manual:");
}

export function manualBillIdFromKey(key: string): string | null {
  return isManualBillKey(key) ? key.slice("manual:".length) : null;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function daysInUtcMonth(year: number, monthZeroBased: number): number {
  return new Date(Date.UTC(year, monthZeroBased + 1, 0)).getUTCDate();
}

/**
 * The day this bill is due in the given calendar month, or `null` when it is
 * not due that month: before its anchor, or a quarterly or yearly bill in a
 * month that is not a whole number of steps after the anchor. The anchor's day
 * of month is kept, shortened to the month's last day where the month is
 * shorter (the 31st becomes the 28th or 29th in February).
 */
export function dueDateInMonth(
  bill: Pick<RecurringBillInput, "cadence" | "anchorDate">,
  year: number,
  monthZeroBased: number,
): Date | null {
  const anchor = bill.anchorDate;
  const anchorIndex = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth();
  const monthIndex = year * 12 + monthZeroBased;
  if (monthIndex < anchorIndex) return null;
  if ((monthIndex - anchorIndex) % MONTHS_PER_STEP[bill.cadence] !== 0) return null;
  return new Date(Date.UTC(year, monthZeroBased, Math.min(anchor.getUTCDate(), daysInUtcMonth(year, monthZeroBased))));
}

/** The first due date on or after `from` (a day), searched up to five years ahead; `null` if none (cannot happen for a valid bill). */
export function nextDueOnOrAfter(bill: Pick<RecurringBillInput, "cadence" | "anchorDate">, from: Date): Date | null {
  const day = startOfUtcDay(from);
  const startIndex = day.getUTCFullYear() * 12 + day.getUTCMonth();
  for (let offset = 0; offset <= 60; offset++) {
    const index = startIndex + offset;
    const due = dueDateInMonth(bill, Math.floor(index / 12), index % 12);
    if (due && due >= day) return due;
  }
  return null;
}

// === Name matching ===========================================================

/** Words too generic to say two names are the same merchant. */
const GENERIC_WORDS = new Set([
  "subscription",
  "subscriptions",
  "payment",
  "payments",
  "premium",
  "membership",
  "monthly",
  "annual",
  "yearly",
  "bill",
  "bills",
  "service",
  "services",
  "online",
  "store",
  "fee",
  "plan",
]);

const MIN_SHARED_WORD_LENGTH = 4;
const NEAR_IDENTICAL_SIMILARITY = 0.82;

function significantWords(name: string): string[] {
  const words = normalizeMerchantForFuzzyMatch(name).match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.filter((word) => word.length >= MIN_SHARED_WORD_LENGTH && !GENERIC_WORDS.has(word));
}

/**
 * Whether two descriptions probably name the same merchant: near-identical
 * after the radar's own normalization, or they share a distinctive word
 * ("Claude Pro" and "CLAUDE.AI SUBSCRIPTION" both contain "claude"). Words are
 * whole words of at least four letters that are not generic ("subscription",
 * "payment", "premium"), so "Phone bill" does not match "Phone repair" on a
 * generic word. A shared word on its own can still be a coincidence; callers
 * that can also compare an amount do, and this is documented as a heuristic.
 */
export function namesMatch(a: string, b: string): boolean {
  const normalizedA = normalizeMerchantForFuzzyMatch(a);
  const normalizedB = normalizeMerchantForFuzzyMatch(b);
  if (normalizedA.length === 0 || normalizedB.length === 0) return false;
  if (normalizedA === normalizedB) return true;
  if (similarityRatio(normalizedA, normalizedB) >= NEAR_IDENTICAL_SIMILARITY) return true;
  const wordsB = new Set(significantWords(b));
  return significantWords(a).some((word) => wordsB.has(word));
}

// === Paid this cycle =========================================================

export type LedgerExpense = {
  displayName: string;
  currency: CurrencyCode;
  /** Signed: negative for an expense. */
  nativeAmount: number;
  occurredAt: Date;
};

/** How far before and after a due date a charge still counts as this cycle's. */
const PAID_WINDOW_DAYS_BEFORE = 10;
const PAID_WINDOW_DAYS_AFTER = 15;
/** A price change or a bank's rounding should not hide a payment. Not checked across currencies. */
const AMOUNT_TOLERANCE = 0.4;

/**
 * The ledger charge that paid this due date, if one has appeared: an expense
 * with a matching name, dated within a few days either side of the due date,
 * and, when it is in the bill's own currency, within a price change of the
 * amount. A charge in another currency (a dollar subscription billed in lira)
 * has no comparable amount, so only its name and date count.
 */
export function findPayment(
  bill: Pick<RecurringBillInput, "name" | "currency" | "nativeAmount">,
  due: Date,
  ledger: readonly LedgerExpense[],
): LedgerExpense | null {
  const from = due.getTime() - PAID_WINDOW_DAYS_BEFORE * MS_PER_DAY;
  const to = due.getTime() + PAID_WINDOW_DAYS_AFTER * MS_PER_DAY;
  let best: LedgerExpense | null = null;
  for (const row of ledger) {
    if (row.nativeAmount >= 0) continue;
    const at = row.occurredAt.getTime();
    if (at < from || at >= to) continue;
    if (!namesMatch(bill.name, row.displayName)) continue;
    if (row.currency === bill.currency) {
      const difference = Math.abs(Math.abs(row.nativeAmount) - bill.nativeAmount) / bill.nativeAmount;
      if (difference > AMOUNT_TOLERANCE) continue;
    }
    if (!best || Math.abs(at - due.getTime()) < Math.abs(best.occurredAt.getTime() - due.getTime())) best = row;
  }
  return best;
}

// === Rows for the radar's list ===============================================

/** A detected subscription, as much of it as the supersede check needs. */
export type DetectedSubscription = {
  displayName: string;
  isRecurring: boolean;
};

export type ManualBillRow = SubscriptionAnalysis & {
  manualBillId: string;
  /** The day of the month the bill is due, so a day the previous month does not have still lands on the right day. */
  dueDay: number;
};

export type SupersededBill = { bill: RecurringBillInput; detectedAs: string };

export type ManualBillRows = {
  /** One row per bill that counts: every bill the radar has not already detected. */
  rows: ManualBillRow[];
  /** Bills the radar has since detected from statements, and what it detected them as. Not counted twice. */
  superseded: SupersededBill[];
};

/**
 * One radar-shaped row per manual bill. `lastSeenAt` is the field Safe to
 * Spend reads to decide whether a bill is still to be charged this month, so
 * it is set to say exactly that: a date in the current month when the bill is
 * paid or not due (nothing pending), or one cadence step back when it is due
 * and unpaid (pending, on its due day). Other consumers of the rows (cost
 * totals, the subscriptions page) only read the amount, cadence, name and
 * `nextExpectedDate`.
 */
export function buildManualBillRows(
  bills: readonly RecurringBillInput[],
  ledger: readonly LedgerExpense[],
  detected: readonly DetectedSubscription[],
  asOf: Date,
): ManualBillRows {
  const today = startOfUtcDay(asOf);
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  const rows: ManualBillRow[] = [];
  const superseded: SupersededBill[] = [];

  for (const bill of bills) {
    const detectedMatch = detected.find((subscription) => subscription.isRecurring && namesMatch(bill.name, subscription.displayName));
    if (detectedMatch) {
      superseded.push({ bill, detectedAs: detectedMatch.displayName });
      continue;
    }

    const dueThisMonth = dueDateInMonth(bill, year, month);
    const paid = dueThisMonth ? findPayment(bill, dueThisMonth, ledger) !== null : false;
    const pending = dueThisMonth !== null && !paid;

    const lastSeenAt = pending
      ? new Date(Date.UTC(year, month - MONTHS_PER_STEP[bill.cadence], 1))
      : today;
    // A bill paid early this month is next due a cycle from now, not on a date it has already been paid for.
    const searchFrom = paid && dueThisMonth ? new Date(dueThisMonth.getTime() + MS_PER_DAY) : new Date(today.getTime() + MS_PER_DAY);
    const nextDue = pending && dueThisMonth ? dueThisMonth : nextDueOnOrAfter(bill, searchFrom);

    rows.push({
      manualBillId: bill.id,
      dueDay: bill.anchorDate.getUTCDate(),
      merchantKey: manualBillKey(bill.id),
      displayName: bill.name,
      currency: bill.currency,
      isRecurring: true,
      cadence: bill.cadence,
      occurrenceCount: 0,
      currentNativeAmount: nativeAmount(-bill.nativeAmount),
      firstSeenAt: bill.anchorDate,
      lastSeenAt,
      nextExpectedDate: nextDue,
      priceHike: null,
      categoryId: bill.categoryId,
      averageIntervalDays: null,
    });
  }

  return { rows, superseded };
}

/**
 * A whole-number amount of minor units as the text a person would type back
 * into the amount field (4990 becomes "49.90"). Integer arithmetic only, so
 * no digit is lost to floating point.
 */
export function minorUnitsToInputText(minorUnits: number): string {
  const whole = Math.trunc(minorUnits / 100);
  const fraction = String(Math.abs(minorUnits) % 100).padStart(2, "0");
  return `${whole}.${fraction}`;
}
