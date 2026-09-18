import { AdvisorChat } from "./_components/advisor-chat";

export const instant = false;

export default function AdvisorPage() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4 md:px-6">
      <div className="border-b border-border pb-3">
        <h1 className="font-display text-xl font-semibold text-fg">Advisor</h1>
        <p className="mt-1 text-sm text-muted">
          Ask about your net worth, spending, budgets, goals, debts, assets, or portfolio. The advisor can only read
          your own PFW data — it never executes code or changes anything.
        </p>
      </div>

      <div className="rounded-lg border border-border bg-surface p-4">
        <AdvisorChat />
      </div>
    </div>
  );
}
