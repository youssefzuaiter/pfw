import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "../../../components/badge/badge";
import { getCurrentUser } from "../../../server/auth/current-user";
import { getOperatorAlertEmail } from "../../../server/env";
import { buildOpsStatusData, type SyncStatus } from "../../../server/ops/build-ops-status-data";
import { BackendStatusBadge } from "../../(finance)/dashboard/_components/backend-status-badge";

export const instant = false;

/**
 * Operations status — which build is live, where the encryption-key
 * rotation stands, how recently each scheduled sync heard from its
 * provider, and whether failure alerting is wired up.
 *
 * Gated to the operator, not every signed-in user: this deployment has
 * demo mode and household members, and none of them run it. The gate is
 * `OPERATOR_ALERT_EMAIL` — one env var, one concept, already set on the
 * deployment for the cron failure alerts (AGENTS.md §3yy). With it
 * unset, nobody is the operator and the page 404s for everyone, which is
 * the right default for a page that names a deployment and a key
 * fingerprint.
 *
 * Reachable by direct link only, deliberately not in
 * `PRIMARY_NAV_ITEMS`/`MobileNav` — the same "sub-view, not one of the
 * spec's 9 primary destinations" pattern as `/vault`, `/analytics`,
 * `/trading/portfolio`.
 */
export default async function OpsStatusPage() {
  const user = await getCurrentUser();
  const operatorEmail = getOperatorAlertEmail();

  // 404, never 403 — consistent with how this app answers every other
  // "you may not see this" case (Section 2.2): a non-operator learns
  // nothing about whether the page exists.
  if (!operatorEmail || user.email.toLowerCase() !== operatorEmail.toLowerCase()) {
    notFound();
  }

  const status = await buildOpsStatusData();

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4 md:px-6">
      <div className="border-b border-border pb-3">
        <Link
          href="/settings"
          className="text-xs text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          ← Settings
        </Link>
        <h1 className="mt-1 font-display text-xl font-semibold text-fg">Operations</h1>
        <p className="mt-1 text-sm text-muted">
          What this deployment is running and whether its scheduled jobs are actually keeping up.
        </p>
      </div>

      <section className="rounded-lg border border-border bg-surface p-4" aria-labelledby="ops-deployment">
        <h2 id="ops-deployment" className="text-xs font-medium uppercase tracking-wide text-muted">
          Deployment
        </h2>
        <dl className="mt-2 flex flex-col gap-2 text-sm">
          <Row label="Environment">
            {status.deployment.environment ?? <span className="text-muted">local development</span>}
          </Row>
          <Row label="Commit">
            {status.deployment.commitSha ? (
              <span className="font-tabular-figures">{status.deployment.commitSha.slice(0, 7)}</span>
            ) : (
              <span className="text-muted">not a Vercel build</span>
            )}
          </Row>
          <Row label="Host">{status.deployment.url ?? <span className="text-muted">localhost</span>}</Row>
          <Row label="Trading agent">
            <BackendStatusBadge />
          </Row>
        </dl>
        <p className="mt-3 text-xs text-muted">
          The commit is the build actually serving this page — compare it against what you last pushed before
          concluding a change is live.
        </p>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4" aria-labelledby="ops-encryption">
        <h2 id="ops-encryption" className="text-xs font-medium uppercase tracking-wide text-muted">
          Encryption key
        </h2>
        <dl className="mt-2 flex flex-col gap-2 text-sm">
          <Row label="Current key">
            <span className="font-tabular-figures">{status.encryptionKey.currentKeyId}</span>
          </Row>
          <Row label="Rotation">
            {status.encryptionKey.rotationInProgress ? (
              <span className="flex flex-wrap items-center gap-2">
                <Badge variant="warning" pulse>
                  In progress
                </Badge>
                <span className="font-tabular-figures text-muted">→ {status.encryptionKey.nextKeyId}</span>
              </span>
            ) : (
              <Badge variant="neutral">Not rotating</Badge>
            )}
          </Row>
        </dl>
        <p className="mt-3 text-xs text-muted">
          These are public fingerprints, not keys — a hash is derivable from a key, never the reverse, and every{" "}
          <code>v2:</code> row already carries one in plaintext. Before cutting <code>ENCRYPTION_KEY</code> over to a
          new value, confirm your stored copy hashes to the target:{" "}
          <code>printf &apos;%s&apos; &quot;$KEY&quot; | base64 -d | shasum -a 256 | cut -c1-12</code>.
        </p>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4" aria-labelledby="ops-syncs">
        <h2 id="ops-syncs" className="text-xs font-medium uppercase tracking-wide text-muted">
          Scheduled data syncs
        </h2>
        <div className="mt-2 flex flex-col gap-1">
          {status.exchangeRates.map((rate) => (
            <SyncRow key={rate.label} status={rate} prefix="Exchange rate" />
          ))}
          <SyncRow status={status.cryptoPrices} />
          <SyncRow status={status.equityQuotes} />
        </div>
        <p className="mt-3 text-xs text-muted">
          The nightly cron runs at 00:00 UTC; these timestamps are its outcome, not its schedule. Exchange rates are
          listed per currency on purpose — one currency the provider skipped would otherwise hide behind a fresh one.
          Equity quotes only sync for tickers held outside the mock universe, so &ldquo;none held&rdquo; is a normal
          state, not a failure.
        </p>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4" aria-labelledby="ops-alerting">
        <h2 id="ops-alerting" className="text-xs font-medium uppercase tracking-wide text-muted">
          Alerting
        </h2>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted">Cron failure email</span>
          {status.operatorAlertConfigured ? (
            <Badge variant="positive">Configured</Badge>
          ) : (
            <Badge variant="warning">Not configured</Badge>
          )}
        </div>
        <p className="mt-3 text-xs text-muted">
          A cron run with any failed job sends one email listing every failure. Sending also needs{" "}
          <code>RESEND_API_KEY</code>; without it the failures are still reported in the cron response, just not
          delivered anywhere.
        </p>
      </section>

      <p className="text-xs text-muted">Read at {status.generatedAt.toISOString().replace("T", " ").slice(0, 16)} UTC.</p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="text-fg">{children}</dd>
    </div>
  );
}

const TIER_VARIANT = {
  fresh: "positive",
  warning: "warning",
  critical: "critical",
  never: "critical",
  not_applicable: "neutral",
} as const;

function describeAge(status: SyncStatus): string {
  if (status.tier === "not_applicable") return "none held";
  if (status.ageHours === null) return "never synced";
  if (status.ageHours < 1) return "under an hour ago";
  if (status.ageHours < 48) return `${Math.round(status.ageHours)}h ago`;
  return `${Math.round(status.ageHours / 24)}d ago`;
}

function SyncRow({ status, prefix }: { status: SyncStatus; prefix?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-1.5 text-sm last:border-b-0">
      <span className="text-fg">{prefix ? `${prefix} — ${status.label}` : status.label}</span>
      <span className="flex items-center gap-2">
        <span className="font-tabular-figures text-xs text-muted">{describeAge(status)}</span>
        <Badge variant={TIER_VARIANT[status.tier]} pulse={status.tier === "critical"}>
          {status.tier === "not_applicable" ? "n/a" : status.tier === "never" ? "never" : status.tier}
        </Badge>
      </span>
    </div>
  );
}
