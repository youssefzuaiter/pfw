import { Badge, type BadgeVariant } from "../../../components/badge/badge";
import { formatAge, formatDuration, formatUtcDateTime } from "../../../lib/core-format";
import type { CoreAgentData } from "../../../server/core/build-core-agent-data";

type Ready = Extract<CoreAgentData, { state: "ready" }>;

function freshnessBadge(freshness: Ready["freshness"]): { variant: BadgeVariant; text: string } {
  const age = freshness.ageSeconds === null ? "" : formatAge(freshness.ageSeconds);
  switch (freshness.state) {
    case "fresh":
      return { variant: "positive", text: age === "just now" ? "Reporting now" : `Reporting · ${age} ago` };
    case "stale":
      return { variant: "neutral", text: `Last report ${age} ago` };
    case "silent":
      return { variant: "warning", text: `Silent for ${age}` };
    case "never":
      return { variant: "neutral", text: "Never reported" };
  }
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className="text-sm text-fg">{children}</dd>
    </div>
  );
}

/**
 * Is the core router alive, trading, and waiting on anything — and can
 * the mirror this page shows be trusted. Three independent answers, kept
 * apart on purpose: the router's own report (`status`), how recently it
 * made one (`freshness`), and whether the journal copy held here still
 * hashes as a chain (`integrity`, recomputed from the stored lines on
 * every read, not stored).
 */
export function CoreStatusCard({ data }: { data: Ready }) {
  const { status, freshness, integrity, mirroredEntries, chainCount, now } = data;
  const fresh = freshnessBadge(freshness);
  const today = now.toISOString().slice(0, 10);
  const notYetEffective = status?.policyEffectiveFrom ? status.policyEffectiveFrom > today : false;
  const behind = status ? status.journal.entries - mirroredEntries : 0;

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4" aria-labelledby="core-status-heading">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="core-status-heading" className="mr-2 text-sm font-medium uppercase tracking-wide text-muted">
          Router
        </h2>
        <Badge variant={fresh.variant}>{fresh.text}</Badge>
        {status &&
          (status.halted ? (
            <Badge variant="critical">Kill switch on</Badge>
          ) : !status.tradingEnabled ? (
            <Badge variant="critical">Trading disabled</Badge>
          ) : (
            <Badge variant="positive">Trading enabled</Badge>
          ))}
        {notYetEffective && status?.policyEffectiveFrom && <Badge variant="neutral">Starts {status.policyEffectiveFrom}</Badge>}
      </div>

      {status && status.attention.length > 0 && (
        <div className="rounded-lg border border-signature/40 bg-signature/10 p-3">
          <p className="text-sm font-medium text-fg">Needs your attention</p>
          <ul className="mt-1 list-disc pl-5 text-sm text-fg">
            {status.attention.map((item, index) => (
              <li key={`${index}-${item}`}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {status ? (
          <>
            <Detail label="Policy">
              <span className="font-tabular-figures">{status.policySha256 ? status.policySha256.slice(0, 12) : "—"}</span>
              {status.policyEffectiveFrom && <span className="text-muted"> · first session {status.policyEffectiveFrom}</span>}
            </Detail>
            <Detail label="Last report">{formatUtcDateTime(status.reportedAt)}</Detail>
            <Detail label="Router's own journal check">
              {status.journal.ok ? (
                <span className="text-positive">Intact · {status.journal.entries} entries</span>
              ) : (
                <span className="text-negative">Failed — {status.journal.reason ?? "no reason given"}</span>
              )}
            </Detail>
            <Detail label="Execution loop">
              {status.tickAgeSeconds === null ? "Has not ticked yet" : `Last tick ${formatDuration(status.tickAgeSeconds)} before the report`}
              {status.tickFailures > 0 && <span className="text-negative"> · {status.tickFailures} failed in a row</span>}
            </Detail>
          </>
        ) : (
          <Detail label="Router">No report received yet — only its journal has arrived.</Detail>
        )}
        <Detail label="This page's copy of the journal">
          {integrity.ok ? (
            <span className="text-positive">Verified · {mirroredEntries} entries, hash chain intact</span>
          ) : (
            <span className="text-negative">
              Does not verify at entry {integrity.atIndex}: {integrity.reason}
            </span>
          )}
          {behind > 0 && <span className="text-muted"> · {behind} newer on the router, not yet received</span>}
          {chainCount > 1 && <span className="text-muted"> · {chainCount - 1} earlier journal(s) kept</span>}
        </Detail>
      </dl>
    </section>
  );
}
