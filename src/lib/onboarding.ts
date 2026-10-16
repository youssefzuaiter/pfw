/**
 * First-run setup (AGENTS.md §3zzz). Pure rules over already-fetched facts,
 * same `src/lib/` convention as every other engine (§3b).
 *
 * Who is sent to the wizard: someone who has not finished or skipped it AND
 * whose app is still empty (no account yet, or an account but nothing in it).
 * The emptiness half is what keeps this safe: anyone who already uses the app
 * has an account and transactions, so they are never redirected, with no
 * backfill needed for users who existed before the wizard did.
 */

export type OnboardingFacts = {
  completedAt: Date | null;
  accountCount: number;
  transactionCount: number;
};

export type OnboardingStep = 1 | 2 | 3;

export function needsOnboarding(facts: OnboardingFacts): boolean {
  if (facts.completedAt !== null) return false;
  return facts.accountCount === 0 || facts.transactionCount === 0;
}

/**
 * Where to pick up. Someone who already added an account has been through the
 * currency and account steps (a reload, or a visit another day), so they
 * resume at the import step instead of repeating them.
 */
export function initialOnboardingStep(facts: Pick<OnboardingFacts, "accountCount">): OnboardingStep {
  return facts.accountCount === 0 ? 1 : 3;
}
