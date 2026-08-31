"use client";

import { useEffect, useRef, useState } from "react";
import { Spinner } from "../../../components/spinner/spinner";
import { embedTextWithTimeout } from "../../../lib/embeddings/local-embedder";
import { agorot } from "../../../lib/money";
import { TransactionsTable, type TransactionRow } from "./transactions-table";

type Category = { id: string; name: string };

type ApiRow = {
  id: string;
  occurredAt: string;
  description: string;
  merchantName: string | null;
  amount: number;
  categoryId: string;
  categoryName: string;
  needsReview: boolean;
};

type SearchResponse = { mode: "semantic" | "substring"; results: ApiRow[] };

const DEBOUNCE_MS = 400;
/** Matches local-embedder.ts's own DEFAULT_EMBEDDING_TIMEOUT_MS — a slow first-time model download must never hang the search box itself; embedTextWithTimeout degrades to `undefined` past this, and the request still goes out as a substring search. */
const EMBEDDING_TIMEOUT_MS = 3_000;

function toTransactionRow(row: ApiRow): TransactionRow {
  return {
    id: row.id,
    occurredAt: new Date(row.occurredAt),
    description: row.description,
    merchantName: row.merchantName,
    amount: agorot(row.amount),
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    needsReview: row.needsReview,
  };
}

/**
 * Owns the free-text search box PLUS the table it filters (AGENTS.md
 * §3cc) — the two have to live in the same client component because a
 * search result set now comes from a client-driven fetch
 * (`POST /api/transactions/search`), not the server-rendered `rows`
 * `page.tsx` passes in as `initialRows`. Category/sort selection stays
 * entirely separate, in `FilterBar`'s URL-param navigation — changing
 * either triggers a real page navigation, which remounts this component
 * fresh with new `initialRows` and clears any in-progress search, so the
 * two filtering mechanisms never fight over which rows are "current."
 *
 * Every search attempt computes a query embedding client-side first
 * (`embedTextWithTimeout`, the multilingual model — Turkish/Arabic/
 * English/Hebrew query text all embed into the SAME comparable space
 * this app's stored transaction embeddings use, AGENTS.md §3aa) and
 * always sends the raw query text too — `POST /api/transactions/search`
 * itself decides semantic vs. substring depending on whether an
 * embedding came through in time, so this component never needs its own
 * fallback branch; it just renders whatever `mode` the response reports.
 */
export function TransactionsExplorer({
  initialRows,
  categories,
  initialQuery,
  categoryId,
  dateFrom,
  dateTo,
}: {
  initialRows: readonly TransactionRow[];
  categories: readonly Category[];
  initialQuery: string;
  categoryId?: string;
  dateFrom?: string;
  dateTo?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [rows, setRows] = useState<readonly TransactionRow[]>(initialRows);
  const [mode, setMode] = useState<"idle" | "searching" | "semantic" | "substring" | "error">("idle");
  const requestIdRef = useRef(0);

  /** Clears any in-flight search too (bumping the ref invalidates its stale-response check below) — called directly from the input's onChange, not derived via an effect, since resetting on an empty query is a direct response to that one event, not a synchronization concern. */
  function handleQueryChange(value: string) {
    setQuery(value);
    if (value.trim() === "") {
      requestIdRef.current++;
      setRows(initialRows);
      setMode("idle");
    }
  }

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) return;

    const thisRequestId = ++requestIdRef.current;

    // Entirely inlined inside the debounce timer's callback, matching
    // monte-carlo-widget.tsx's/tax-simulator.tsx's established shape for
    // this exact pattern — every setState call, including the initial
    // "searching" one, runs deferred (inside setTimeout, never
    // synchronously in the effect body itself), which is what keeps
    // this outside the react-hooks/set-state-in-effect rule's reach.
    const timer = setTimeout(() => {
      void (async () => {
        setMode("searching");
        const embedding = await embedTextWithTimeout(trimmed, EMBEDDING_TIMEOUT_MS);
        // A newer keystroke started a later request while this one was
        // awaiting the embedding/fetch — dropping a stale response here
        // is what stops a slow early response from clobbering a faster
        // later one, the same race the debounced widgets elsewhere in
        // this app guard against with AbortController (§3n/§3r); a
        // plain monotonic request-id check does the same job with less
        // machinery, since nothing here needs to actually cancel an
        // in-flight fetch early.
        if (thisRequestId !== requestIdRef.current) return;

        try {
          const response = await fetch("/api/transactions/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: trimmed, embedding, categoryId, dateFrom, dateTo }),
          });
          if (thisRequestId !== requestIdRef.current) return;
          if (!response.ok) {
            setMode("error");
            return;
          }
          const data = (await response.json()) as SearchResponse;
          if (thisRequestId !== requestIdRef.current) return;
          setRows(data.results.map(toTransactionRow));
          setMode(data.mode);
        } catch {
          if (thisRequestId === requestIdRef.current) setMode("error");
        }
      })();
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
    // initialRows/categoryId/dateFrom/dateTo are read fresh via closure
    // on every debounce firing — only `query` should re-trigger the
    // debounce timer itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  return (
    <div className="flex flex-col gap-3">
      <div role="search" className="flex flex-wrap items-center gap-3">
        <label className="sr-only" htmlFor="transaction-search">
          Search transactions
        </label>
        <div className="relative min-w-[220px] flex-1">
          <input
            id="transaction-search"
            type="search"
            value={query}
            onChange={(event) => handleQueryChange(event.target.value)}
            placeholder="Search merchant or description, in any language…"
            className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {mode === "searching" && (
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
              <Spinner size="sm" />
            </span>
          )}
        </div>
      </div>

      {mode === "semantic" && (
        <p className="text-xs text-muted">Showing semantic matches for &ldquo;{query}&rdquo;.</p>
      )}
      {mode === "substring" && query.trim() !== "" && (
        <p className="text-xs text-muted">
          Semantic search wasn&rsquo;t available for this search — showing exact-text matches for &ldquo;{query}&rdquo;
          instead.
        </p>
      )}
      {mode === "error" && (
        <p className="text-xs text-negative">Search failed — showing your last results. Try again in a moment.</p>
      )}

      <TransactionsTable rows={rows} categories={categories} />
    </div>
  );
}
