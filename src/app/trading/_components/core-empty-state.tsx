/** The mirror exists but the router has never reported: how to connect it. */
export function CoreEmptyState() {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted">Not connected yet</h2>
      <p className="mt-2 text-sm text-fg">
        The long-term core has not reported to this account. It starts the first time its router runs with{" "}
        <code className="font-tabular-figures">CORE_PFW_SYNC_URL</code> pointing at this site&rsquo;s{" "}
        <code className="font-tabular-figures">/api/webhooks/core</code> and the same shared secret the trading agent already
        uses; its journal and account then appear here within a few minutes.
      </p>
      <p className="mt-2 text-sm text-muted">
        Nothing is lost while it is not connected: the router keeps its own journal and sends from where it left off.
      </p>
    </section>
  );
}

/** The migration that creates the mirror's tables has not been applied to this deployment. */
export function CoreUnavailable() {
  return (
    <section className="rounded-lg border border-signature/40 bg-signature/10 p-4">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted">Not set up on this deployment</h2>
      <p className="mt-2 text-sm text-fg">
        The tables this page reads have not been created here yet. Apply the <code className="font-tabular-figures">core_agent_mirror</code>{" "}
        migration; until then the router keeps its place and its journal, and nothing is lost.
      </p>
    </section>
  );
}
