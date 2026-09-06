import { AgentTelemetryTerminal } from "../_components/agent-telemetry-terminal";
import { TradingNav } from "../_components/trading-nav";

export const instant = false;

/**
 * A live view into the Tier-0 paper-trading agent's own FastAPI process
 * (~/paper-trader) — NOT a PFW/DAL screen. There is no server-side data
 * fetch here (no getCurrentUser()/DAL call): the agent's telemetry lives
 * in that OTHER process's memory, not this app's database, so the whole
 * page is one client component polling that process directly. See
 * AgentTelemetryTerminal's own doc comment and src/proxy.ts's connect-src
 * comment for the CORS/CSP wiring this requires.
 */
export default function AgentActivityPage() {
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
    </div>
  );
}
