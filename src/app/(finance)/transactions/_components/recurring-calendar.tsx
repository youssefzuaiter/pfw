import Link from "next/link";
import type { CalendarEntry, CalendarEntryState, MonthCalendar } from "../../../../lib/bill-calendar";
import { formatNativeAmount, nativeAmount } from "../../../../lib/currency";

/**
 * One month of what is charged, for one page (AGENTS.md §3gggg). A month grid
 * on wide screens for the overview, and a day-by-day list for everyone: the list
 * is what a screen reader and a phone use, so the grid is hidden from assistive
 * technology rather than read out twice.
 */

const STATE_LABEL: Record<CalendarEntryState, string> = {
  paid: "Paid",
  due: "Due",
  "not-charged": "Not charged yet",
};

const STATE_TEXT: Record<CalendarEntryState, string> = {
  paid: "text-positive",
  due: "text-signature",
  "not-charged": "text-negative",
};

const STATE_DOT: Record<CalendarEntryState, string> = {
  paid: "bg-positive",
  due: "bg-signature",
  "not-charged": "bg-negative",
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function amountText(entry: CalendarEntry): string {
  return formatNativeAmount(nativeAmount(entry.nativeAmount), entry.currency);
}

export function RecurringCalendar({ calendar, basePath, currentMonthKey, noun }: { calendar: MonthCalendar; basePath: string; currentMonthKey: string; noun: string }) {
  const busyDays = calendar.days.filter((day) => day.entries.length > 0);
  const { paid, due, notCharged } = calendar.counts;

  return (
    <section aria-labelledby={`${noun}-calendar-heading`} className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${noun}-calendar-heading`} className="text-xs font-medium uppercase tracking-wide text-muted">
          Calendar · {calendar.monthLabel}
        </h2>
        <nav aria-label={`Choose a month for the ${noun} calendar`} className="flex items-center gap-1.5">
          <Link
            href={`${basePath}?month=${calendar.previousMonthKey}`}
            className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted hover:bg-elevated-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            ← Previous
          </Link>
          {calendar.monthKey !== currentMonthKey && (
            <Link
              href={basePath}
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted hover:bg-elevated-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              This month
            </Link>
          )}
          <Link
            href={`${basePath}?month=${calendar.nextMonthKey}`}
            className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted hover:bg-elevated-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Next →
          </Link>
        </nav>
      </div>

      <p className="mb-3 text-sm text-muted">
        {paid + due + notCharged === 0
          ? `Nothing charged or due this month.`
          : `${paid} paid, ${due} still due, ${notCharged} not charged yet.`}
      </p>

      <div aria-hidden="true" className="hidden md:block">
        <div className="mb-1 grid grid-cols-7 gap-1 text-center text-xs text-muted">
          {WEEKDAYS.map((weekday) => (
            <div key={weekday}>{weekday}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: calendar.leadingBlanks }, (_, index) => (
            <div key={`blank-${index}`} />
          ))}
          {calendar.days.map((day) => (
            <div
              key={day.date}
              className={`min-h-[4.5rem] rounded-md border p-1.5 text-xs ${day.isToday ? "border-accent" : "border-border"}`}
            >
              <div className={day.isToday ? "font-semibold text-accent" : "text-muted"}>{day.day}</div>
              {day.entries.slice(0, 2).map((entry) => (
                <div key={`${entry.itemKey}-${entry.state}`} className="mt-0.5 flex items-center gap-1 truncate text-fg">
                  <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${STATE_DOT[entry.state]}`} />
                  <span className="truncate">{entry.name}</span>
                </div>
              ))}
              {day.entries.length > 2 && <div className="mt-0.5 text-muted">+{day.entries.length - 2} more</div>}
            </div>
          ))}
        </div>
      </div>

      <h3 className="mb-2 mt-4 text-xs font-medium uppercase tracking-wide text-muted md:mt-5">Day by day</h3>
      {busyDays.length === 0 ? (
        <p className="text-sm text-muted">No {noun} fall in {calendar.monthLabel}.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {busyDays.map((day) => (
            <li key={day.date} className="flex flex-col gap-1 border-t border-border pt-2 first:border-t-0 first:pt-0">
              <p className={`text-sm font-medium ${day.isToday ? "text-accent" : "text-fg"}`}>
                <time dateTime={day.date}>{day.date}</time>
                {day.isToday && <span className="font-normal text-muted"> · today</span>}
              </p>
              <ul className="flex flex-col gap-1">
                {day.entries.map((entry) => (
                  <li key={`${entry.itemKey}-${entry.state}`} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                    <span className="text-fg">
                      {entry.name} <span className={`text-xs ${STATE_TEXT[entry.state]}`}>{STATE_LABEL[entry.state]}</span>
                    </span>
                    <span className="font-tabular-figures tracking-tight text-fg">{amountText(entry)}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
