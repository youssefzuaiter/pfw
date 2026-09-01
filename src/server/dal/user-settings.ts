import "server-only";
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
};

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
