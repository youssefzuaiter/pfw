"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "../../../../../components/badge/badge";
import { Spinner } from "../../../../../components/spinner/spinner";
import { formatNativeAmount, nativeAmount, type CurrencyCode } from "../../../../../lib/currency";

export type TransferMatchView = {
  outId: string;
  inId: string;
  outAccount: string;
  inAccount: string;
  outLabel: string;
  inLabel: string;
  /** `YYYY-MM-DD`. */
  outDate: string;
  inDate: string;
  outCurrency: CurrencyCode;
  inCurrency: CurrencyCode;
  /** Signed, minor units. */
  outNative: number;
  inNative: number;
  dayGap: number;
  crossCurrency: boolean;
  ambiguous: boolean;
  preselected: boolean;
};

type Done = { applied: number; skipped: number; changedIds: string[] };

/**
 * The proposed transfers between the user's own accounts (AGENTS.md §3kkkk).
 * Only the clear same-currency ones start ticked; the rest are the user's call.
 * After applying, the rows that were marked can be unmarked again in one click.
 */
export function TransferMatchesPanel({ matches }: { matches: TransferMatchView[] }) {
  const router = useRouter();
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(matches.filter((m) => m.preselected).map((m) => m.outId)));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [undone, setUndone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearCount = matches.filter((m) => m.preselected).length;

  function handleToggle(event: React.ChangeEvent<HTMLInputElement>) {
    // Read from the event now: the updater below runs later, when currentTarget is gone.
    const id = event.currentTarget.dataset.outId ?? "";
    const checked = event.currentTarget.checked;
    setTicked((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function handleTickClear() {
    setTicked(new Set(matches.filter((m) => m.preselected).map((m) => m.outId)));
  }

  function handleTickAll() {
    setTicked(new Set(matches.map((m) => m.outId)));
  }

  function handleTickNone() {
    setTicked(new Set());
  }

  async function handleApply() {
    setBusy(true);
    setError(null);
    setUndone(false);
    try {
      const pairs = matches.filter((m) => ticked.has(m.outId)).map((m) => ({ outId: m.outId, inId: m.inId }));
      const response = await fetch("/api/transactions/transfer-matches/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairs }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not mark the transfers");
      setDone({ applied: body.applied, skipped: body.skipped, changedIds: body.changedIds });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not mark the transfers");
    } finally {
      setBusy(false);
    }
  }

  async function handleUndo() {
    if (!done) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/transactions/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: done.changedIds, action: { type: "transfer", isTransfer: false } }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not undo");
      setUndone(true);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not undo");
    } finally {
      setBusy(false);
    }
  }

  const doneNote = done && (
    <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-4 text-sm">
      <p className="text-fg">
        {undone
          ? "Those transfers were unmarked."
          : `Marked ${done.applied} ${done.applied === 1 ? "pair" : "pairs"} as transfers.${done.skipped > 0 ? ` ${done.skipped} no longer matched and were left alone.` : ""}`}
      </p>
      {!undone && done.changedIds.length > 0 && (
        <button
          type="button"
          onClick={handleUndo}
          disabled={busy}
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-fg hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        >
          Undo
        </button>
      )}
    </div>
  );

  if (matches.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {doneNote}
        {error && <p role="alert" className="text-sm text-negative">{error}</p>}
        <p className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-muted">
          No transfers found. A transfer shows up here when money leaves one of your accounts and the same amount arrives in another within three days.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {doneNote}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {matches.length} possible {matches.length === 1 ? "transfer" : "transfers"}. {clearCount} {clearCount === 1 ? "is" : "are"} clear and ticked; check the others yourself.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleTickClear}
            className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted hover:bg-elevated-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Clear ones only
          </button>
          <button
            type="button"
            onClick={handleTickAll}
            className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted hover:bg-elevated-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Tick all
          </button>
          <button
            type="button"
            onClick={handleTickNone}
            className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted hover:bg-elevated-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Tick none
          </button>
        </div>
      </div>

      <ul className="rounded-lg border border-border bg-surface">
        {matches.map((m) => {
          const label = `${m.outLabel || "Payment"} from ${m.outAccount} to ${m.inAccount}`;
          return (
            <li key={m.outId} className="flex items-start gap-3 border-b border-border px-4 py-3 last:border-0">
              <input
                type="checkbox"
                checked={ticked.has(m.outId)}
                data-out-id={m.outId}
                onChange={handleToggle}
                aria-label={`Mark as a transfer: ${label}`}
                className="mt-1 h-4 w-4 shrink-0 accent-[var(--pfw-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <div className="grid min-w-0 flex-1 gap-1 text-sm sm:grid-cols-2 sm:gap-4">
                <div className="min-w-0">
                  <p className="text-xs text-muted">
                    Out · <span className="font-tabular-figures tracking-tight">{m.outDate}</span> · {m.outAccount}
                  </p>
                  <p className="truncate text-fg">{m.outLabel || "(no description)"}</p>
                  <p className="font-tabular-figures font-medium tracking-tight text-fg">{formatNativeAmount(nativeAmount(m.outNative), m.outCurrency)}</p>
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted">
                    In · <span className="font-tabular-figures tracking-tight">{m.inDate}</span> · {m.inAccount}
                  </p>
                  <p className="truncate text-fg">{m.inLabel || "(no description)"}</p>
                  <p className="font-tabular-figures font-medium tracking-tight text-positive">
                    {formatNativeAmount(nativeAmount(m.inNative), m.inCurrency, { showPositiveSign: true })}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5 sm:col-span-2">
                  {m.crossCurrency && <Badge variant="neutral">Different currencies</Badge>}
                  {m.ambiguous && <Badge variant="warning">Could match more than one row</Badge>}
                  {m.dayGap > 0 && <Badge variant="neutral">{m.dayGap} {m.dayGap === 1 ? "day" : "days"} apart</Badge>}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {error && <p role="alert" className="text-sm text-negative">{error}</p>}

      <div>
        <button
          type="button"
          onClick={handleApply}
          disabled={busy || ticked.size === 0}
          className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {busy && <Spinner size="sm" />}
          Mark {ticked.size} {ticked.size === 1 ? "pair" : "pairs"} as transfers
        </button>
      </div>
    </div>
  );
}
