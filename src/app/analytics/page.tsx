import { buildMonteCarloAnalytics, serializeMonteCarloAnalytics } from "../../server/analytics/build-monte-carlo-data";
import { getCurrentUser } from "../../server/auth/current-user";
import { MonteCarloWidget } from "./_components/monte-carlo-widget";

export const instant = false;

/**
 * First-paint assumption only, never stored — this app has no date of
 * birth field (AGENTS.md law #6), so there is no DAL-derived age to
 * default to. The widget lets the user change it immediately; nothing
 * here persists it.
 */
const DEFAULT_CURRENT_AGE = 35;

export default async function AnalyticsPage() {
  const user = await getCurrentUser();
  const analytics = await buildMonteCarloAnalytics(user.id, DEFAULT_CURRENT_AGE);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-6 md:px-6">
      <div>
        <h1 className="font-display text-2xl font-semibold text-fg">Retirement analytics</h1>
        <p className="mt-1 text-sm text-muted">
          A probabilistic FIRE / retirement Monte Carlo projection — {analytics.result.numSimulations.toLocaleString()}
          {" "}simulated market paths, run fresh against your current net worth and asset allocation.
        </p>
      </div>
      <MonteCarloWidget initialCurrentAge={DEFAULT_CURRENT_AGE} initialData={serializeMonteCarloAnalytics(analytics)} />
    </div>
  );
}
