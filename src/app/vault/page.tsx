import { getCurrentUser } from "../../server/auth/current-user";
import { getVaultStatus } from "../../server/dal/dead-mans-switch";
import { VaultDashboard } from "./_components/vault-dashboard";
import { VaultSetupWizard } from "./_components/vault-setup-wizard";

export const instant = false;

/**
 * The Cryptographic Dead Man's Switch's owner-facing Emergency Vault
 * (AGENTS.md §3t). Reachable by direct link only, same "sub-view, not
 * one of the spec's 9 primary destinations" pattern as /welcome (§3f),
 * /trading/portfolio (§3l), /analytics (§3n), and
 * /transactions/subscriptions (§3p) — deliberately not added to
 * PRIMARY_NAV_ITEMS/MobileNav.
 */
export default async function VaultPage() {
  const user = await getCurrentUser();
  const status = await getVaultStatus(user.id);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 md:px-6">
      <div>
        <h1 className="font-display text-2xl font-semibold text-fg">Emergency Vault</h1>
        <p className="mt-1 text-sm text-muted">
          A cryptographic dead man&apos;s switch — if you go inactive for too long, trusted beneficiaries can combine
          their shares to unlock emergency documents. No single beneficiary, and no server administrator, can ever
          unlock it alone.
        </p>
      </div>

      {status.isSetUp ? <VaultDashboard status={status} /> : <VaultSetupWizard />}
    </div>
  );
}
