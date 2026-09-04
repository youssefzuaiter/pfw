"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "../../../components/badge/badge";
import { Spinner } from "../../../components/spinner/spinner";
import { formatAgorot, agorot } from "../../../lib/money";

type LedgerCommitView = {
  id: string;
  action: "CREATE" | "UPDATE";
  previousHash: string | null;
  currentHash: string;
  patchData: {
    categoryName: string;
    amountAgorot: string;
    description: string;
    merchantName: string | null;
    occurredAtIso: string;
  };
  createdAtIso: string;
};

type LedgerResponse = {
  commits: LedgerCommitView[];
  chainValid: boolean;
  brokenAtCommitId: string | null;
};

type Stage = "idle" | "loading" | "ready" | "error";

// Deliberately narrow — this dialog's content is fixed, not arbitrary
// markup — same convention and same reasoning as ReceiptScannerModal's
// and MobileNav's drawer.
const FOCUSABLE_SELECTOR = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled])";

function shortHash(hash: string | null): string {
  return hash ? hash.slice(0, 12) : "—";
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString();
}

/**
 * Read-only audit timeline for Cryptographic Ledger Versioning (ad hoc)
 * — shows one transaction's immutable, hash-chained edit history and
 * whether the chain still verifies. Deliberately has NO rollback/undo
 * action: scoped down from an originally-requested rollback engine after
 * a real architecture conflict was raised and confirmed with the user
 * (see prisma/schema.prisma's `LedgerCommit` model doc comment for the
 * full reasoning) — this is tamper-EVIDENCE, not a mutation mechanism.
 * Historical transaction state stays frozen, consistent with every other
 * feature in this app.
 *
 * Same focus-trap/Escape-to-close/focus-restore-on-close pattern as
 * `ReceiptScannerModal` — copied, not abstracted into a shared component,
 * matching this app's own established precedent for this exact shape of
 * dialog (`MobileNav`'s drawer took the same approach).
 */
export function LedgerHistoryModal({ transactionId, label }: { transactionId: string; label: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [data, setData] = useState<LedgerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const dialogNode = dialogRef.current;
    dialogNode?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        handleClose();
        return;
      }
      if (event.key !== "Tab" || !dialogNode) return;

      const focusable = Array.from(dialogNode.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen]);

  function handleOpen() {
    setIsOpen(true);
    setStage("loading");
    setError(null);
    void (async () => {
      try {
        const response = await fetch(`/api/transactions/${transactionId}/ledger`);
        const body = await response.json();
        if (!response.ok) {
          throw new Error(body.error ?? "Failed to load history");
        }
        setData(body as LedgerResponse);
        setStage("ready");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load history");
        setStage("error");
      }
    })();
  }

  function handleClose() {
    setIsOpen(false);
    openButtonRef.current?.focus();
  }

  return (
    <>
      <button
        ref={openButtonRef}
        type="button"
        onClick={handleOpen}
        className="uv-btn-press rounded-md border border-border px-2 py-1 text-xs font-medium text-muted transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        History
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close"
            onClick={handleClose}
            className="absolute inset-0 bg-black/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          />
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="ledger-history-title"
            className="relative z-10 flex max-h-[90vh] w-full max-w-lg flex-col overflow-y-auto rounded-lg border border-border bg-surface p-5 shadow-2xl"
          >
            <div className="mb-1 flex items-center justify-between">
              <h2 id="ledger-history-title" className="font-display text-lg font-semibold text-fg">
                Change history
              </h2>
              <button
                type="button"
                onClick={handleClose}
                aria-label="Close"
                className="rounded-md p-1 text-muted hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                ✕
              </button>
            </div>
            <p className="mb-4 text-xs text-muted">{label}</p>

            {stage === "loading" && (
              <div className="flex flex-col items-center gap-3 py-8">
                <Spinner />
                <p className="text-sm text-muted">Loading history…</p>
              </div>
            )}

            {stage === "error" && <p className="py-8 text-center text-sm text-negative">{error}</p>}

            {stage === "ready" && data && (
              <div className="flex flex-col gap-3">
                <div>
                  {data.chainValid ? (
                    <Badge variant="positive">Chain verified</Badge>
                  ) : (
                    <Badge variant="critical" pulse>
                      Tampering detected
                    </Badge>
                  )}
                </div>
                {!data.chainValid && (
                  <p className="text-xs text-negative">
                    A recorded change no longer matches its own cryptographic hash — this history may have been
                    altered outside the normal application flow.
                  </p>
                )}
                <p className="text-xs text-muted">
                  This is a read-only, tamper-evident record — there is no way to undo or roll back a change from
                  here.
                </p>

                <ol className="flex flex-col gap-2">
                  {data.commits.map((commit) => {
                    const isBroken = commit.id === data.brokenAtCommitId;
                    return (
                      <li
                        key={commit.id}
                        className={`rounded-md border p-3 text-sm ${isBroken ? "border-negative/40 bg-negative/10" : "border-border bg-bg"}`}
                      >
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          <Badge variant={commit.action === "CREATE" ? "positive" : "neutral"}>
                            {commit.action === "CREATE" ? "Created" : "Updated"}
                          </Badge>
                          <span className="font-tabular-figures text-xs text-muted">
                            {formatTimestamp(commit.createdAtIso)}
                          </span>
                        </div>
                        <p className="text-fg">
                          {commit.patchData.categoryName} ·{" "}
                          <span className="font-tabular-figures">
                            {formatAgorot(agorot(Number(commit.patchData.amountAgorot)))}
                          </span>
                        </p>
                        <p className="mt-1 font-mono text-[11px] text-muted">
                          {shortHash(commit.previousHash)} → {shortHash(commit.currentHash)}
                        </p>
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
