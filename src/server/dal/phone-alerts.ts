import "server-only";
import { formatNativeAmount, nativeAmount } from "../../lib/currency";
import { monthKeyFor } from "../../lib/date-month";
import { maskTopic } from "../../lib/ntfy-topic";
import { LARGE_EXPENSES_LISTED, type PhoneAlertFacts, type PhoneAlertState } from "../../lib/phone-alerts";
import { withUserScope } from "../db/with-user-scope";
import { getReportingFormatter } from "../reporting/reporting-context";
import { getEnvelopeBalances } from "./envelopes";
import { LIVE, REAL_MONEY } from "./transactions";

/**
 * DAL for phone alerts (AGENTS.md §3qqq). Every function is scoped to one
 * user through `withUserScope`; the nightly job's one cross-user query
 * (who has alerts on) lives in `src/server/alerts/phone-alerts-job.ts`.
 *
 * The topic never leaves this module towards a page: settings get
 * `topicHint` (the last four characters), and only the send paths read the
 * full name.
 */
export const DEFAULT_LARGE_EXPENSE_AGOROT = 100_000;
const NOTIFICATIONS_FORWARDED = 10;
const LABEL_MAX = 60;

export type PhoneAlertSettings = { topicHint: string; largeExpenseAgorot: number; includeDetails: boolean };

export async function getPhoneAlertSettings(userId: string): Promise<PhoneAlertSettings | null> {
  const row = await withUserScope(userId, (tx) => tx.phoneAlertSubscription.findUnique({ where: { userId } }));
  if (!row) return null;
  return { topicHint: maskTopic(row.topic), largeExpenseAgorot: Number(row.largeExpenseAgorot), includeDetails: row.includeDetails };
}

/** Turns alerts on, or changes the topic. A changed topic keeps where the nightly check left off. */
export async function enablePhoneAlerts(userId: string, topic: string): Promise<PhoneAlertSettings> {
  const row = await withUserScope(userId, (tx) =>
    tx.phoneAlertSubscription.upsert({ where: { userId }, create: { userId, topic }, update: { topic } }),
  );
  return { topicHint: maskTopic(row.topic), largeExpenseAgorot: Number(row.largeExpenseAgorot), includeDetails: row.includeDetails };
}

/** Null when alerts are off. `update` (never `updateMany`, which the encryption extension refuses on this model). */
export async function updatePhoneAlertPreferences(
  userId: string,
  input: { largeExpenseAgorot?: number; includeDetails?: boolean },
): Promise<PhoneAlertSettings | null> {
  return withUserScope(userId, async (tx) => {
    const existing = await tx.phoneAlertSubscription.findUnique({ where: { userId }, select: { id: true } });
    if (!existing) return null;
    const row = await tx.phoneAlertSubscription.update({
      where: { userId },
      data: {
        ...(input.largeExpenseAgorot !== undefined ? { largeExpenseAgorot: BigInt(input.largeExpenseAgorot) } : {}),
        ...(input.includeDetails !== undefined ? { includeDetails: input.includeDetails } : {}),
      },
    });
    return { topicHint: maskTopic(row.topic), largeExpenseAgorot: Number(row.largeExpenseAgorot), includeDetails: row.includeDetails };
  });
}

/** Turns alerts off: the row, topic and state go together. */
export async function disablePhoneAlerts(userId: string): Promise<boolean> {
  const { count } = await withUserScope(userId, (tx) => tx.phoneAlertSubscription.deleteMany({ where: { userId } }));
  return count > 0;
}

export type PhoneAlertDelivery = {
  topic: string;
  largeExpenseAgorot: number;
  includeDetails: boolean;
  state: PhoneAlertState;
};

/** Everything a send needs, topic included. Server-side callers only. */
export async function getPhoneAlertDelivery(userId: string): Promise<PhoneAlertDelivery | null> {
  const row = await withUserScope(userId, (tx) => tx.phoneAlertSubscription.findUnique({ where: { userId } }));
  if (!row) return null;
  return {
    topic: row.topic,
    largeExpenseAgorot: Number(row.largeExpenseAgorot),
    includeDetails: row.includeDetails,
    state: {
      lastCheckedAt: row.lastCheckedAt,
      overdrawnCategoryIds: row.overdrawnCategoryIds,
      importReminderSentAt: row.importReminderSentAt,
    },
  };
}

export async function savePhoneAlertState(userId: string, state: PhoneAlertState): Promise<void> {
  await withUserScope(userId, (tx) =>
    tx.phoneAlertSubscription.update({
      where: { userId },
      data: {
        lastCheckedAt: state.lastCheckedAt,
        overdrawnCategoryIds: [...state.overdrawnCategoryIds],
        importReminderSentAt: state.importReminderSentAt,
      },
    }),
  );
}

function truncate(label: string): string {
  return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label;
}

/**
 * The facts one nightly check decides on. "New" means reached the ledger
 * (or the notification list) in (`since`, `now`]: by `createdAt`, not by
 * `occurredAt`, because an imported statement brings rows dated weeks ago
 * that are still news tonight. With no `since` (the first check) there is
 * nothing new by definition.
 *
 * "Overdrawn" means an envelope the user has put money into at least once
 * and has since spent past. The dashboard also counts a category that was
 * never budgeted as overdrawn (its balance is negative by construction); a
 * notification about each one would buzz once for every category of
 * someone who does not budget, so phone alerts leave those out.
 */
export async function gatherPhoneAlertFacts(
  userId: string,
  options: { since: Date | null; now: Date; largeExpenseAgorot: number },
): Promise<PhoneAlertFacts> {
  const { since, now, largeExpenseAgorot } = options;
  const window = since ? { gt: since, lte: now } : null;

  const [envelopes, format, recent] = await Promise.all([
    getEnvelopeBalances(userId, monthKeyFor(now)),
    getReportingFormatter(userId),
    withUserScope(userId, async (tx) => {
      const largeWhere = window
        ? { userId, ...REAL_MONEY, amount: { lte: BigInt(-largeExpenseAgorot) }, createdAt: window }
        : null;
      const [budgeted, notifications, largeExpenses, largeExpenseCount, lastImport] = await Promise.all([
        tx.envelopeAllocation.findMany({
          where: { userId, amountAgorot: { gt: 0n } },
          distinct: ["categoryId"],
          select: { categoryId: true },
        }),
        window
          ? tx.notification.findMany({
              where: { userId, createdAt: window },
              orderBy: { createdAt: "asc" },
              take: NOTIFICATIONS_FORWARDED,
              select: { message: true },
            })
          : [],
        largeWhere
          ? tx.notableTransaction.findMany({
              where: largeWhere,
              orderBy: { amount: "asc" },
              take: LARGE_EXPENSES_LISTED,
              select: { merchantName: true, description: true, nativeAmount: true, currency: true, occurredAt: true },
            })
          : [],
        largeWhere ? tx.notableTransaction.count({ where: largeWhere }) : 0,
        tx.notableTransaction.aggregate({
          where: {
            userId,
            ...LIVE,
            OR: [{ providerTransactionId: { startsWith: "csv:" } }, { providerTransactionId: { startsWith: "psd2:" } }],
          },
          _max: { createdAt: true },
        }),
      ]);
      return {
        budgetedCategoryIds: new Set(budgeted.map((row) => row.categoryId)),
        notifications,
        largeExpenses,
        largeExpenseCount,
        lastImportAt: lastImport._max.createdAt,
      };
    }),
  ]);

  return {
    now,
    notifications: recent.notifications.map((row) => row.message),
    overdrawn: envelopes
      .filter((envelope) => envelope.balanceAgorot < 0 && recent.budgetedCategoryIds.has(envelope.categoryId))
      .map((envelope) => ({ categoryId: envelope.categoryId, name: envelope.categoryName, balance: format(envelope.balanceAgorot) })),
    largeExpenses: recent.largeExpenses.map((row) => ({
      label: truncate(row.merchantName ?? row.description),
      amount: formatNativeAmount(nativeAmount(Number(row.nativeAmount)), row.currency),
      day: row.occurredAt.toISOString().slice(0, 10),
    })),
    largeExpenseCount: recent.largeExpenseCount,
    lastImportAt: recent.lastImportAt,
  };
}
