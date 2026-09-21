"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Spinner } from "../../../components/spinner/spinner";
import { SUPPORTED_CURRENCIES } from "../../../lib/currency";

const ACCOUNT_TYPES = [
  { value: "CHECKING", label: "Checking" },
  { value: "SAVINGS", label: "Savings" },
  { value: "CREDIT_CARD", label: "Credit card" },
] as const;

const CURRENCIES = SUPPORTED_CURRENCIES;

export function CreateBankAccountForm() {
  const router = useRouter();
  const [institutionName, setInstitutionName] = useState("");
  const [last4, setLast4] = useState("");
  const [accountType, setAccountType] = useState<(typeof ACCOUNT_TYPES)[number]["value"]>("CHECKING");
  const [nickname, setNickname] = useState("");
  const [currency, setCurrency] = useState<(typeof CURRENCIES)[number]>("ILS");
  const [nativeBalance, setNativeBalance] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!institutionName.trim() || !/^\d{4}$/.test(last4) || !nativeBalance.trim()) return;

    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/bank-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          institutionName: institutionName.trim(),
          last4,
          accountType,
          nickname: nickname.trim() || undefined,
          currency,
          nativeBalance: nativeBalance.trim(),
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to add bank account");
      }
      setInstitutionName("");
      setLast4("");
      setNickname("");
      setNativeBalance("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add bank account");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="bank-institution" className="text-xs font-medium text-muted">
          Institution
        </label>
        <input
          id="bank-institution"
          value={institutionName}
          onChange={(event) => setInstitutionName(event.target.value)}
          placeholder="Bank Leumi"
          className="min-w-[140px] rounded-md border border-border bg-elevated px-3 py-2 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="bank-last4" className="text-xs font-medium text-muted">
          Last 4 digits
        </label>
        <input
          id="bank-last4"
          inputMode="numeric"
          maxLength={4}
          value={last4}
          onChange={(event) => setLast4(event.target.value.replace(/\D/g, "").slice(0, 4))}
          placeholder="1234"
          className="w-20 rounded-md border border-border bg-elevated px-3 py-2 font-tabular-figures tracking-tight text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="bank-nickname" className="text-xs font-medium text-muted">
          Nickname (optional)
        </label>
        <input
          id="bank-nickname"
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
          placeholder="Everyday spending"
          className="min-w-[140px] rounded-md border border-border bg-elevated px-3 py-2 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="bank-type" className="text-xs font-medium text-muted">
          Type
        </label>
        <select
          id="bank-type"
          value={accountType}
          onChange={(event) => setAccountType(event.target.value as (typeof ACCOUNT_TYPES)[number]["value"])}
          className="rounded-md border border-border bg-elevated px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {ACCOUNT_TYPES.map((type) => (
            <option key={type.value} value={type.value}>
              {type.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="bank-currency" className="text-xs font-medium text-muted">
          Currency
        </label>
        <select
          id="bank-currency"
          value={currency}
          onChange={(event) => setCurrency(event.target.value as (typeof CURRENCIES)[number])}
          className="rounded-md border border-border bg-elevated px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {CURRENCIES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="bank-balance" className="text-xs font-medium text-muted">
          {accountType === "CREDIT_CARD" ? "Amount owed" : "Current balance"}
        </label>
        <input
          id="bank-balance"
          inputMode="decimal"
          value={nativeBalance}
          onChange={(event) => setNativeBalance(event.target.value)}
          placeholder="0.00"
          className="w-32 rounded-md border border-border bg-elevated px-3 py-2 font-tabular-figures tracking-tight text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <button
        type="submit"
        disabled={isSubmitting}
        className="uv-btn-press flex items-center gap-2 rounded-md border border-border bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {isSubmitting && <Spinner />}
        {isSubmitting ? "Adding…" : "Add bank account"}
      </button>
      {error && <p className="w-full text-sm text-negative">{error}</p>}
    </form>
  );
}
