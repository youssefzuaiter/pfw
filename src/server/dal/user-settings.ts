import "server-only";
import type { CurrencyCode } from "../../lib/currency";
import { withUserScope } from "../db/with-user-scope";

/**
 * DAL for `UserSettings` (Punch List Tier 2, item 1 — see the model's own
 * schema doc comment for what it does and deliberately does NOT persist).
 * One row per user, created lazily on first read rather than at
 * registration — every existing user (including every seeded demo row)
 * transparently gets the schema's own column defaults with no backfill.
 */

export type UserSettingsData = {
  taxJurisdiction: "US" | "DE" | "INTL";
  taxMethod: "FIFO" | "LIFO";
  taxOtherOrdinaryIncomeAgorot: bigint;
  taxIncludeNiit: boolean;
  /** 0-1 fraction — see the schema column's own doc comment. */
  taxChurchTaxRate: number;
  taxAnnualAllowanceAgorot: bigint | null;
  taxFlatRatePercent: number | null;
  monteCarloRetirementAge: number;
  monteCarloTargetAnnualSpendAgorot: bigint | null;
  monteCarloVolatilityMultiplier: number;
  defaultManualAssetLiquidityTier: "LIQUID" | "SEMI_LIQUID" | "ILLIQUID" | null;
  preferredCurrencyDisplay: "NATIVE" | "ILS";
  monthlyReportEnabled: boolean;
  monthlyReportLastSentMonth: string | null;
  /** Display only — see the schema column (AGENTS.md §3nnn). */
  reportingCurrency: CurrencyCode;
  /** Whether savings accounts count as spendable cash in Safe to Spend (AGENTS.md §3yyy). */
  safeToSpendCountSavings: boolean;
};

/**
 * Just the Safe to Spend savings preference, as a plain read (a dashboard
 * view must not write). No row yet means the default: savings count.
 */
export async function getSafeToSpendCountSavings(userId: string): Promise<boolean> {
  const row = await withUserScope(userId, (tx) =>
    tx.userSettings.findUnique({ where: { userId }, select: { safeToSpendCountSavings: true } }),
  );
  return row?.safeToSpendCountSavings ?? true;
}

/**
 * Just the reporting currency, as a plain read: the root layout asks on
 * every page, and `getOrCreateUserSettings` would make that a write. No
 * row yet means the default, ILS.
 */
export async function getReportingCurrency(userId: string): Promise<CurrencyCode> {
  const row = await withUserScope(userId, (tx) =>
    tx.userSettings.findUnique({ where: { userId }, select: { reportingCurrency: true } }),
  );
  return row?.reportingCurrency ?? "ILS";
}

/**
 * Upsert-on-read: the schema's own column defaults ARE the "no row yet"
 * state, so creating a row with no explicit data the first time a user's
 * settings are ever read is equivalent to returning defaults, while also
 * giving every later read a real row to update against. Idempotent under
 * concurrent first-reads via Prisma's `upsert` (a unique constraint on
 * `userId` backs it, so a race resolves to one winning insert, not two
 * rows).
 */
export async function getOrCreateUserSettings(userId: string): Promise<UserSettingsData> {
  return withUserScope(userId, (tx) =>
    tx.userSettings.upsert({
      where: { userId },
      create: { userId },
      update: {},
    }),
  );
}

export type UpdateUserSettingsInput = Partial<UserSettingsData>;

export async function updateUserSettings(userId: string, input: UpdateUserSettingsInput): Promise<UserSettingsData> {
  return withUserScope(userId, (tx) =>
    tx.userSettings.upsert({
      where: { userId },
      create: { userId, ...input },
      update: input,
    }),
  );
}

export type MonthlyReportClaim = { claimed: true; previous: string | null } | { claimed: false };

/**
 * Claims `monthKey`'s monthly report for sending (AGENTS.md §3lll): sets
 * `monthlyReportLastSentMonth` to it, but only if the user has opted in and
 * that month has not been claimed yet. A conditional update, so two runs
 * racing on the same night cannot both send. Returns the previous value, for
 * `releaseMonthlyReport` to put back if the send fails.
 */
export async function claimMonthlyReport(userId: string, monthKey: string): Promise<MonthlyReportClaim> {
  return withUserScope(userId, async (tx) => {
    const settings = await tx.userSettings.findUnique({ where: { userId } });
    if (!settings?.monthlyReportEnabled || settings.monthlyReportLastSentMonth === monthKey) return { claimed: false };

    const { count } = await tx.userSettings.updateMany({
      where: {
        userId,
        monthlyReportEnabled: true,
        OR: [{ monthlyReportLastSentMonth: null }, { monthlyReportLastSentMonth: { not: monthKey } }],
      },
      data: { monthlyReportLastSentMonth: monthKey },
    });
    return count === 1 ? { claimed: true, previous: settings.monthlyReportLastSentMonth } : { claimed: false };
  });
}

/** Undoes a claim after a failed send, so the next night tries again. Only touches a row still holding this claim. */
export async function releaseMonthlyReport(userId: string, monthKey: string, previous: string | null): Promise<void> {
  await withUserScope(userId, (tx) =>
    tx.userSettings.updateMany({
      where: { userId, monthlyReportLastSentMonth: monthKey },
      data: { monthlyReportLastSentMonth: previous },
    }),
  );
}
