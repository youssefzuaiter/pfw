import "server-only";
import { needsOnboarding, type OnboardingFacts } from "../../lib/onboarding";
import type { CurrencyCode } from "../../lib/currency";
import { withUserScope } from "../db/with-user-scope";
import { LIVE } from "./transactions";

export type OnboardingState = OnboardingFacts & { reportingCurrency: CurrencyCode };

/**
 * What the wizard needs to know, as plain reads: the dashboard asks on every
 * visit, so this must never write. No settings row yet means not completed
 * and the default currency.
 */
export async function getOnboardingState(userId: string): Promise<OnboardingState> {
  return withUserScope(userId, async (tx) => {
    const [settings, accountCount, transactionCount] = await Promise.all([
      tx.userSettings.findUnique({ where: { userId }, select: { onboardingCompletedAt: true, reportingCurrency: true } }),
      tx.bankAccount.count({ where: { userId } }),
      tx.notableTransaction.count({ where: { userId, ...LIVE } }),
    ]);
    return {
      completedAt: settings?.onboardingCompletedAt ?? null,
      accountCount,
      transactionCount,
      reportingCurrency: settings?.reportingCurrency ?? "ILS",
    };
  });
}

/** Whether the dashboard should send this user to the wizard (see `needsOnboarding`). */
export async function userNeedsOnboarding(userId: string): Promise<boolean> {
  return needsOnboarding(await getOnboardingState(userId));
}

/**
 * Records that the user finished or skipped setup. Idempotent: a second call
 * keeps the first time, so "when did they finish" stays true.
 */
export async function markOnboardingComplete(userId: string): Promise<Date> {
  return withUserScope(userId, async (tx) => {
    const existing = await tx.userSettings.findUnique({ where: { userId }, select: { onboardingCompletedAt: true } });
    if (existing?.onboardingCompletedAt) return existing.onboardingCompletedAt;
    const now = new Date();
    await tx.userSettings.upsert({
      where: { userId },
      create: { userId, onboardingCompletedAt: now },
      update: { onboardingCompletedAt: now },
    });
    return now;
  });
}
