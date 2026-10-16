"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ReportingCurrencySelect } from "../../../components/currency/reporting-currency-select";
import { Spinner } from "../../../components/spinner/spinner";
import type { CurrencyCode } from "../../../lib/currency";
import type { OnboardingStep } from "../../../lib/onboarding";
import { ImportCsvForm } from "../../(finance)/transactions/_components/import-csv-form";
import { CreateBankAccountForm, type CreatedBankAccount } from "../../assets/_components/create-bank-account-form";

export type OnboardingAccountOption = { id: string; label: string; currency: string };

const STEPS: readonly { step: OnboardingStep; title: string }[] = [
  { step: 1, title: "Currency" },
  { step: 2, title: "First account" },
  { step: 3, title: "Your transactions" },
];

function optionFor(account: CreatedBankAccount): OnboardingAccountOption {
  return { id: account.id, label: `${account.nickname ?? account.institutionName} · ${account.currency}`, currency: account.currency };
}

/**
 * The three-step first-run setup. It adds no form logic of its own: step 1 is
 * the same currency chooser Settings uses, step 2 is the Assets page's
 * "Add bank account" form, step 3 is the Transactions page's statement
 * importer. What it owns is the order, the way out ("Skip setup" on every
 * step, and "enter by hand" on the last), and recording that setup is done so
 * the dashboard stops sending the user here.
 */
export function OnboardingWizard({
  initialStep,
  initialCurrency,
  accounts,
}: {
  initialStep: OnboardingStep;
  initialCurrency: CurrencyCode;
  accounts: readonly OnboardingAccountOption[];
}) {
  const router = useRouter();
  const [step, setStep] = useState<OnboardingStep>(initialStep);
  const [currency, setCurrency] = useState<CurrencyCode>(initialCurrency);
  const [created, setCreated] = useState<OnboardingAccountOption[]>([]);
  const [imported, setImported] = useState<number | null>(null);
  const [busy, setBusy] = useState<"currency" | "finish" | "manual" | "skip" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The server's list plus anything added during this visit, so the import
  // step has the new account the moment it is made, before the page refreshes.
  const options = [...accounts, ...created.filter((account) => !accounts.some((known) => known.id === account.id))];

  async function complete(destination: string, kind: "finish" | "manual" | "skip") {
    setBusy(kind);
    setError(null);
    try {
      const response = await fetch("/api/onboarding/complete", { method: "POST" });
      if (!response.ok) throw new Error("Could not save your progress. Try again.");
      router.push(destination);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your progress. Try again.");
      setBusy(null);
    }
  }

  async function handleCurrencyContinue() {
    setBusy("currency");
    setError(null);
    try {
      const response = await fetch("/api/user-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportingCurrency: currency }),
      });
      if (!response.ok) throw new Error("Could not save your currency. Try again.");
      router.refresh();
      setStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your currency. Try again.");
    } finally {
      setBusy(null);
    }
  }

  function handleAccountCreated(account: CreatedBankAccount) {
    setCreated((current) => [...current, optionFor(account)]);
    setStep(3);
  }
  function handleImported(result: { importedCount: number }) {
    setImported(result.importedCount);
  }
  function handleSkipClick() {
    void complete("/dashboard", "skip");
  }
  function handleFinishClick() {
    void complete("/dashboard", "finish");
  }
  function handleManualClick() {
    void complete("/transactions", "manual");
  }
  function handleContinueClick() {
    void handleCurrencyContinue();
  }
  function handleSkipAccountClick() {
    setStep(3);
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-6 md:px-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-display text-xl font-semibold text-fg">Set up PFW</h1>
        <button
          type="button"
          onClick={handleSkipClick}
          disabled={busy !== null}
          className="rounded text-sm text-muted underline-offset-2 hover:text-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {busy === "skip" ? "Skipping…" : "Skip setup"}
        </button>
      </div>

      <ol className="flex flex-wrap gap-2 text-xs" aria-label="Setup steps">
        {STEPS.map(({ step: number, title }) => (
          <li
            key={number}
            aria-current={number === step ? "step" : undefined}
            className={`rounded-full border px-3 py-1 ${
              number === step ? "border-accent bg-accent/10 text-fg" : "border-border text-muted"
            }`}
          >
            {number}. {title}
          </li>
        ))}
      </ol>

      {step === 1 ? (
        <section aria-labelledby="onboarding-step-heading" className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
          <h2 id="onboarding-step-heading" className="text-sm font-semibold text-fg">
            Which currency do you want to see your totals in?
          </h2>
          <p className="text-sm text-muted">
            This only changes how totals are shown. Each account keeps its own currency, and you can change this any time
            in Settings.
          </p>
          <div className="flex flex-col gap-1">
            <label htmlFor="onboarding-currency" className="text-xs font-medium text-muted">
              Show totals in
            </label>
            <ReportingCurrencySelect id="onboarding-currency" value={currency} onChange={setCurrency} />
          </div>
          <div>
            <button
              type="button"
              onClick={handleContinueClick}
              disabled={busy !== null}
              className="uv-btn-press flex items-center gap-2 rounded-md border border-border bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {busy === "currency" && <Spinner />}
              Continue
            </button>
          </div>
        </section>
      ) : null}

      {step === 2 ? (
        <section aria-labelledby="onboarding-step-heading" className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
          <h2 id="onboarding-step-heading" className="text-sm font-semibold text-fg">
            Add your first account
          </h2>
          <p className="text-sm text-muted">
            The account your statements are from. The balance is what it holds today; if it is from an earlier day, give
            that day so nothing is counted twice.
          </p>
          <CreateBankAccountForm onCreated={handleAccountCreated} />
          <div>
            <button
              type="button"
              onClick={handleSkipAccountClick}
              className="rounded text-sm text-muted underline-offset-2 hover:text-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              I&apos;ll add an account later
            </button>
          </div>
        </section>
      ) : null}

      {step === 3 ? (
        <section aria-labelledby="onboarding-step-heading" className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
          <h2 id="onboarding-step-heading" className="text-sm font-semibold text-fg">
            Bring in your transactions
          </h2>
          {options.length > 0 ? (
            <>
              <p className="text-sm text-muted">
                Upload a bank statement (CSV or PDF). You see exactly what will be added before anything is saved.
              </p>
              <ImportCsvForm bankAccounts={options} onImported={handleImported} />
            </>
          ) : (
            <p className="text-sm text-muted">
              Add an account first to import a statement. You can do that from Assets any time, or finish setup and add
              transactions by hand.
            </p>
          )}
          {imported !== null ? (
            <p role="status" className="text-sm text-fg">
              {imported > 0 ? `${imported} transactions added.` : "Nothing new was added."} You can import more from
              Transactions later.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
            <button
              type="button"
              onClick={handleFinishClick}
              disabled={busy !== null}
              className="uv-btn-press flex items-center gap-2 rounded-md border border-border bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {busy === "finish" && <Spinner />}
              {imported !== null ? "Finish setup" : "Finish without importing"}
            </button>
            <button
              type="button"
              onClick={handleManualClick}
              disabled={busy !== null}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {busy === "manual" ? "One moment…" : "Enter transactions by hand instead"}
            </button>
          </div>
        </section>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-negative">
          {error}
        </p>
      ) : null}
    </div>
  );
}
