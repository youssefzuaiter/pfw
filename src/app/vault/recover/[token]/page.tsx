import { getRecoveryPortalStatus } from "../../../../server/dead-mans-switch/recovery-service";
import { RecoveryPortal } from "../_components/recovery-portal";

export const instant = false;

/**
 * The public beneficiary recovery portal (AGENTS.md §3t) — the one page
 * in this app NOT scoped to the authenticated seeded demo user. Reached
 * only via a per-beneficiary invite link generated once at vault setup
 * (src/app/vault/_components/vault-setup-wizard.tsx) and never listed
 * anywhere in the app's own navigation.
 */
export default async function RecoveryPortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const status = await getRecoveryPortalStatus(token);

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 px-4 py-6 md:px-6">
      <div>
        <h1 className="font-display text-2xl font-semibold text-fg">Emergency Vault Recovery</h1>
        <p className="mt-1 text-sm text-muted">
          You&apos;ve received a recovery link for someone&apos;s Emergency Vault. You&apos;ll also need the share
          value they gave you separately — this link alone cannot unlock anything.
        </p>
      </div>

      <RecoveryPortal token={token} initialStatus={status} />
    </div>
  );
}
