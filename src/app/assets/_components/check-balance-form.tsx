"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Spinner } from "../../../components/spinner/spinner";
import { formatNativeAmount, nativeAmount, type CurrencyCode } from "../../../lib/currency";
import type { Cause } from "../../../lib/balance-check";

type RowDetail = { id: string; day: string; label: string; deltaNative: number };

type CheckResponse = {
  ok: true;
  accountLabel: string;
  day: string;
  result: { expectedNative: number; bankNative: number; gapNative: number; status: "matches" | "bank-higher" | "bank-lower"; causes: Cause[] };
  rows: RowDetail[];
  movementCount: number;
  approximate: boolean;
};

function describeCause(cause: Cause, rows: Map<string, RowDetail>, money: (n: number) => string): string {
  const named = (id: string) => {
    const row = rows.get(id);
    return row ? `${row.label || "a transaction"} on ${row.day} (${money(Math.abs(row.deltaNative))})` : "a transaction";
  };
  switch (cause.kind) {
    case "duplicate":
      return `${named(cause.rowId)} looks like a duplicate of ${named(cause.twinId)}. If the bank has it once, delete one of them.`;
    case "extra-row":
      return `${named(cause.rowId)} is exactly the size of the gap. The bank may not have it yet, or it may not belong in this account.`;
    case "wrong-sign":
      return `${named(cause.rowId)} may have the wrong sign: the gap is exactly twice its size.`;
    case "missing-or-start":
      return "A transaction of exactly this size may be missing from your data, or the balance you entered earlier was off by this much.";
  }
}

/**
 * "Check against bank": the user types what their bank shows and the day it is
 * for; the app works out its own figure for that day, shows any gap and the
 * likely reasons, and offers the existing "use the bank's balance" fix
 * (AGENTS.md §3oooo). Nothing is changed by checking.
 */
export function CheckBalanceForm({ accountId, isCard, currency }: { accountId: string; isCard: boolean; currency: CurrencyCode }) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [balance, setBalance] = useState("");
  const [day, setDay] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<CheckResponse | null>(null);
  const [fixed, setFixed] = useState(false);

  const money = (value: number) => formatNativeAmount(nativeAmount(value), currency);

  function handleOpen() {
    setDay(new Date().toISOString().slice(0, 10));
    setIsOpen(true);
  }

  function handleClose() {
    setIsOpen(false);
    setOutcome(null);
    setFixed(false);
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!balance.trim() || !day) return;
    setBusy(true);
    setError(null);
    setOutcome(null);
    setFixed(false);
    try {
      const response = await fetch(`/api/bank-accounts/${accountId}/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ balance: balance.trim(), day }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not check the balance");
      setOutcome(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not check the balance");
    } finally {
      setBusy(false);
    }
  }

  async function handleUseBank() {
    if (!outcome) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/bank-accounts/${accountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nativeBalance: balance.trim(), balanceAsOf: outcome.day }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not update the balance");
      setFixed(true);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the balance");
    } finally {
      setBusy(false);
    }
  }

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={handleOpen}
        className="uv-btn-press rounded-md border border-border px-3 py-1 text-xs font-medium text-fg transition-colors hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Check against bank
      </button>
    );
  }

  const rows = new Map((outcome?.rows ?? []).map((row) => [row.id, row]));
  const gap = outcome?.result.gapNative ?? 0;

  return (
    <div className="mt-1 flex flex-col gap-3 rounded-md border border-border bg-bg p-3">
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted">
          {isCard ? "Amount owed your bank shows" : "Balance your bank shows"}
          <input
            value={balance}
            onChange={(event) => setBalance(event.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            className="w-36 rounded-md border border-border bg-elevated px-2 py-1 text-right text-sm font-tabular-figures tracking-tight text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          For the day
          <input
            type="date"
            value={day}
            onChange={(event) => setDay(event.target.value)}
            className="rounded-md border border-border bg-elevated px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <button
          type="submit"
          disabled={busy || !balance.trim() || !day}
          className="uv-btn-press inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {busy && <Spinner size="sm" />}
          Check
        </button>
        <button
          type="button"
          onClick={handleClose}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-elevated-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Close
        </button>
      </form>

      {error && <p role="alert" className="text-xs text-negative">{error}</p>}

      {outcome && (
        <div role="status" className="flex flex-col gap-2 text-sm">
          <p className="text-fg">
            PFW works out <span className="font-tabular-figures font-medium tracking-tight">{money(outcome.result.expectedNative)}</span> for {outcome.day}; your bank shows{" "}
            <span className="font-tabular-figures font-medium tracking-tight">{money(outcome.result.bankNative)}</span>.
          </p>
          {outcome.result.status === "matches" ? (
            <p className="font-medium text-positive">They match. Nothing to fix.</p>
          ) : (
            <>
              <p className="font-medium text-negative">
                Difference {money(Math.abs(gap))}: your bank shows {gap > 0 ? "more" : "less"}{isCard ? " owed" : ""} than PFW.
              </p>
              <p className="text-xs text-muted">Likely reasons, most likely first:</p>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-fg">
                {outcome.result.causes.map((cause, index) => (
                  <li key={index}>{describeCause(cause, rows, money)}</li>
                ))}
              </ul>
              {outcome.approximate && (
                <p className="text-xs text-muted">Some transactions in this account were entered in another currency, so PFW&apos;s figure is approximate.</p>
              )}
              {fixed ? (
                <p className="text-xs text-positive">Done. PFW now counts transactions from the day after {outcome.day}.</p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleUseBank}
                    disabled={busy}
                    className="uv-btn-press inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-fg hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    Use the bank&apos;s balance
                  </button>
                  <span className="text-xs text-muted">Sets {money(outcome.result.bankNative)} as of {outcome.day} and counts transactions after it.</span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
