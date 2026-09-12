import { AdvisorChat } from "./_components/advisor-chat";

export const instant = false;

export default function AdvisorPage() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4 md:px-6">
      <div className="border-b border-slate-800/80 pb-3">
        <h1 className="font-display text-xl font-semibold text-slate-100">Advisor</h1>
        <p className="mt-1 text-sm text-slate-400">
          Ask about your net worth, spending, budgets, goals, debts, assets, or portfolio. The advisor can only read
          your own PFW data — it never executes code or changes anything.
        </p>
      </div>

      <div className="rounded-lg border border-slate-800/80 bg-slate-900 p-4">
        <AdvisorChat />
      </div>
    </div>
  );
}
