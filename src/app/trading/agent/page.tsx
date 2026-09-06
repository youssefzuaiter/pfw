import { getCurrentUser } from "../../../server/auth/current-user";
import { listScenarioMetrics } from "../../../server/dal/scenario-metrics";
import { AgentPredictedMoveChart } from "../_components/agent-predicted-move-chart";
import { AgentTelemetryTerminal } from "../_components/agent-telemetry-terminal";
import { TradingNav } from "../_components/trading-nav";

export const instant = false;

/**
 * Two genuinely different data sources on one page, kept honestly
 * distinct rather than blended: the live wake/evaluate/reject/execute
 * event stream still comes from the Tier-0 agent's own FastAPI process
 * (`AgentTelemetryTerminal`, unchanged — see its own doc comment), which
 * this app's database has no record of at all. The new predicted-move
 * chart below it (Phase 2, ad hoc) is the first read this page has ever
 * done against PFW's own `ScenarioMetrics` table — the persisted,
 * webhook-recorded history of every scenario the agent has evaluated,
 * independent of whether that process happens to be running right now.
 */
export default async function AgentActivityPage() {
  const user = await getCurrentUser();
  const scenarioMetrics = await listScenarioMetrics(user.id);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-6 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-semibold text-fg">Agent Activity</h1>
        <TradingNav active="agent" />
      </div>

      <p className="text-sm text-muted">
        Real-time view into the Tier-0 autonomous paper-trading agent — wake/evaluate/reject/execute/sleep events,
        polled directly from its FastAPI process every few seconds.
      </p>

      <section className="rounded-lg border border-border bg-surface p-4">
        <AgentTelemetryTerminal />
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">Predicted move % — history</h2>
        <AgentPredictedMoveChart rows={scenarioMetrics} />
        <p className="mt-2 text-xs text-muted">
          Every scenario the agent has evaluated, recorded via its webhook to this app&rsquo;s own database — persists
          across restarts of the FastAPI process above, unlike the live event stream.
        </p>
      </section>
    </div>
  );
}
