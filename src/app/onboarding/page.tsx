import { redirect } from "next/navigation";
import { initialOnboardingStep } from "../../lib/onboarding";
import { getCurrentUser } from "../../server/auth/current-user";
import { listBankAccounts } from "../../server/dal/bank-accounts";
import { getOnboardingState } from "../../server/dal/onboarding";
import { OnboardingWizard } from "./_components/onboarding-wizard";

export const instant = false;

/**
 * First-run setup (AGENTS.md §3zzz): currency, first account, first statement.
 * Someone who already finished or skipped it goes straight to the dashboard,
 * so this is only ever a place a new user is sent, not a page that nags.
 */
export default async function OnboardingPage() {
  const user = await getCurrentUser();
  const [state, accounts] = await Promise.all([getOnboardingState(user.id), listBankAccounts(user.id)]);
  if (state.completedAt !== null) redirect("/dashboard");

  return (
    <OnboardingWizard
      initialStep={initialOnboardingStep(state)}
      initialCurrency={state.reportingCurrency}
      accounts={accounts.map((account) => ({
        id: account.id,
        label: `${account.nickname ?? account.institutionName} · ${account.currency}`,
        currency: account.currency,
      }))}
    />
  );
}
