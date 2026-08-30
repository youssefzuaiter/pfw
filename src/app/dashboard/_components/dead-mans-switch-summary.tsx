import Link from "next/link";
import { Badge, type BadgeVariant } from "../../../components/badge/badge";

export type DeadMansSwitchSummaryProps = {
  isSetUp: boolean;
  status: "ACTIVE" | "GRACE_PERIOD" | "TRIGGERED" | "RECOVERED" | null;
};

const STATUS_LABEL: Record<NonNullable<DeadMansSwitchSummaryProps["status"]>, string> = {
  ACTIVE: "Active",
  GRACE_PERIOD: "Grace period",
  TRIGGERED: "Recovery open",
  RECOVERED: "Recovered",
};

const STATUS_VARIANT: Record<NonNullable<DeadMansSwitchSummaryProps["status"]>, BadgeVariant> = {
  ACTIVE: "positive",
  GRACE_PERIOD: "warning",
  TRIGGERED: "critical",
  RECOVERED: "neutral",
};

/**
 * A compact "Emergency Vault" card for the dashboard (AGENTS.md §3t) —
 * just enough to see the switch's current state and jump into `/vault`,
 * where setup, beneficiaries, and documents actually live. Same
 * deliberately-small pattern as HouseholdSummary (§3s) — the dashboard's
 * job is a glanceable overview, not a second copy of the management UI.
 */
export function DeadMansSwitchSummary({ isSetUp, status }: DeadMansSwitchSummaryProps) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4" aria-labelledby="dead-mans-switch-heading">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 id="dead-mans-switch-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
          Emergency Vault
        </h2>
        <Link
          href="/vault"
          className="text-xs font-medium text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Manage →
        </Link>
      </div>
      {!isSetUp || !status ? (
        <p className="text-sm text-muted">
          Not set up yet.{" "}
          <Link href="/vault" className="text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Set up a cryptographic dead man&apos;s switch
          </Link>{" "}
          so trusted beneficiaries can reach emergency documents if you go inactive.
        </p>
      ) : (
        <Badge variant={STATUS_VARIANT[status]} pulse={status === "GRACE_PERIOD" || status === "TRIGGERED"}>
          {STATUS_LABEL[status]}
        </Badge>
      )}
    </section>
  );
}
