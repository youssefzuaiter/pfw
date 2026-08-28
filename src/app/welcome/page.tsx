import Link from "next/link";
import { HeroCanvas } from "../../components/hero/hero-canvas";

// Static entry surface — no per-user data, so unlike every other screen in
// this app it's free to prerender. Nothing here reads headers()/cookies().
export const metadata = {
  title: "PFW — Personal Finance OS",
};

export default function WelcomePage() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-10 px-4 py-10 md:px-6 md:py-16">
      <div className="grid items-center gap-10 md:grid-cols-2 md:gap-16">
        <div className="flex flex-col gap-6">
          <p className="text-sm font-medium uppercase tracking-wide text-muted">Personal finance, one ledger</p>
          <h1 className="font-display text-4xl font-semibold text-fg md:text-5xl">
            Every shekel, every debt, every trade — in one view.
          </h1>
          <p className="max-w-prose text-base text-muted">
            PFW tracks spending, budgets, goals, debts, and a simulated equities desk against your real financial
            picture, with an AI advisor that only ever reads your ledger — never guesses at it.
          </p>
          <div>
            <Link
              href="/dashboard"
              className="uv-btn-press inline-flex items-center gap-2 rounded-md border border-border bg-accent px-5 py-2.5 text-sm font-medium text-bg transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Enter dashboard
            </Link>
          </div>
        </div>

        <div className="h-72 w-full md:h-[26rem]">
          <HeroCanvas />
        </div>
      </div>
    </div>
  );
}
