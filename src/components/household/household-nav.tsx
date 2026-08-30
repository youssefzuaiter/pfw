import Link from "next/link";

export type HouseholdGroupOption = { id: string; name: string };

/**
 * The "Personal Ledger / Household Spaces" toggle (AGENTS.md §3s) — a
 * tab per joined group, plus the always-present Personal tab, driven by
 * a `?view=household&group=<id>` searchParam on whichever page renders
 * it, same "GET-searchParam view switch, no client JS needed" pattern
 * `/debts`' avalanche-vs-snowball comparison already uses.
 */
export function HouseholdNav({
  basePath,
  groups,
  activeGroupId,
}: {
  basePath: string;
  groups: readonly HouseholdGroupOption[];
  activeGroupId: string | null;
}) {
  return (
    <nav className="flex flex-wrap gap-2" aria-label="Personal vs. household view">
      {activeGroupId === null ? (
        <span
          aria-current="page"
          className="rounded-full border border-accent bg-accent/10 px-3 py-1 text-xs font-medium text-accent"
        >
          Personal Ledger
        </span>
      ) : (
        <Link
          href={basePath}
          className="rounded-full border border-border px-3 py-1 text-xs font-medium text-muted hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Personal Ledger
        </Link>
      )}
      {groups.map((group) =>
        group.id === activeGroupId ? (
          <span
            key={group.id}
            aria-current="page"
            className="rounded-full border border-accent bg-accent/10 px-3 py-1 text-xs font-medium text-accent"
          >
            {group.name}
          </span>
        ) : (
          <Link
            key={group.id}
            href={`${basePath}?view=household&group=${group.id}`}
            className="rounded-full border border-border px-3 py-1 text-xs font-medium text-muted hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {group.name}
          </Link>
        ),
      )}
    </nav>
  );
}
