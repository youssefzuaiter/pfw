import Link from "next/link";
import { Badge } from "../../../components/badge/badge";

export type HouseholdSummaryRow = {
  id: string;
  name: string;
  role: "OWNER" | "MEMBER";
  permission: "READ" | "WRITE";
  sharedBudgetCount: number;
  sharedAccountCount: number;
};

/**
 * A compact "Household Spaces" card for the dashboard (AGENTS.md §3s) —
 * just enough to see what's shared and jump into the full view on
 * `/budgets`, which is where the toggle, admin panel, and invite flow
 * actually live. Kept deliberately small here: the dashboard's job is a
 * glanceable overview, not a second copy of the household management UI.
 */
export function HouseholdSummary({ households }: { households: HouseholdSummaryRow[] }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4" aria-labelledby="household-heading">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 id="household-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
          Household Spaces
        </h2>
        <Link
          href="/budgets"
          className="text-xs font-medium text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Manage →
        </Link>
      </div>
      {households.length === 0 ? (
        <p className="text-sm text-muted">
          Not part of any household yet.{" "}
          <Link href="/budgets" className="text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Create or join one
          </Link>{" "}
          to share specific budgets, accounts, or categories — everything else stays personal.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {households.map((household) => (
            <li key={household.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 first:border-t-0 first:pt-0">
              <Link
                href={`/budgets?view=household&group=${household.id}`}
                className="text-sm text-fg underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {household.name}
              </Link>
              <span className="flex items-center gap-2 text-xs text-muted">
                {household.sharedBudgetCount} budget{household.sharedBudgetCount === 1 ? "" : "s"} ·{" "}
                {household.sharedAccountCount} account{household.sharedAccountCount === 1 ? "" : "s"}
                <Badge variant={household.permission === "WRITE" ? "positive" : "neutral"}>
                  {household.role === "OWNER" ? "Owner" : household.permission}
                </Badge>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
