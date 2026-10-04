import { formatUtcDateTime } from "../../../lib/core-format";
import type { EventTone } from "../../../lib/core-journal";
import type { CoreEventView } from "../../../server/core/build-core-agent-data";

const TONE_CLASS: Record<EventTone, string> = {
  positive: "text-positive",
  warning: "text-signature",
  critical: "text-negative",
  neutral: "text-fg",
};

/**
 * The router's journal, newest first, one line each. The short hash is the
 * entry's own sha256 — it is what the next entry's `prev` points at, so
 * the owner can match a line here against `core-journal.jsonl` on the
 * router's disk. Everything shown was written by the router and is
 * rendered as text.
 */
export function CoreJournalFeed({ events, hiddenCount }: { events: CoreEventView[]; hiddenCount: number }) {
  if (events.length === 0) return <p className="text-sm text-muted">The journal is empty.</p>;
  return (
    <>
      <ol className="flex flex-col" aria-label="Journal entries, newest first">
        {events.map((event) => (
          <li key={event.hash} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-border py-2 text-sm last:border-b-0">
            <time dateTime={event.at.toISOString()} className="w-44 shrink-0 font-tabular-figures text-xs text-muted">
              {formatUtcDateTime(event.at)}
            </time>
            <span className={`font-medium ${TONE_CLASS[event.tone]}`}>{event.label}</span>
            {event.detail && <span className="min-w-0 break-words text-muted">{event.detail}</span>}
            <span className="ml-auto font-tabular-figures text-xs text-muted" title={`entry ${event.index} · sha256 ${event.hash}`}>
              #{event.index} · {event.hash.slice(0, 8)}
            </span>
          </li>
        ))}
      </ol>
      {hiddenCount > 0 && <p className="mt-2 text-xs text-muted">{hiddenCount} earlier entries are not shown.</p>}
    </>
  );
}
