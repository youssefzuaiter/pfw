import { type Agorot, addAgorot, agorot } from "./money";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HORIZON_DAYS = 60;

function truncateToDate(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

export type RecurringProjection = {
  merchantKey: string;
  /** Signed: negative for a bill/subscription, positive for recurring income like salary. */
  amount: Agorot;
  averageIntervalDays: number;
  lastOccurredAt: Date;
};

export type ForecastEvent = {
  merchantKey: string;
  amount: Agorot;
};

export type ForecastDay = {
  date: Date;
  projectedBalance: Agorot;
  events: readonly ForecastEvent[];
};

export type CashFlowForecast = {
  days: readonly ForecastDay[];
  /** The single lowest projected balance point in the window — the whole reason this forecast exists, per the spec: "not just the ending balance." */
  minimum: { date: Date; balance: Agorot };
  endingBalance: Agorot;
};

/** All projected occurrence dates of a recurring item that fall strictly inside (windowStart, windowEnd]. */
function projectOccurrenceDates(
  lastOccurredAt: Date,
  averageIntervalDays: number,
  windowStart: Date,
  windowEnd: Date,
): Date[] {
  if (averageIntervalDays <= 0) {
    throw new RangeError(`averageIntervalDays must be positive, received ${averageIntervalDays}`);
  }

  const dates: Date[] = [];
  let next = new Date(lastOccurredAt.getTime());
  const intervalMs = averageIntervalDays * DAY_MS;

  // Advance to the first projected occurrence strictly after windowStart.
  // (A guard against an unreasonably tiny interval turning into a
  // runaway loop for a badly-formed input — 100k iterations is already
  // far more than any real interval/window combination needs.)
  let guard = 0;
  while (next <= windowStart) {
    next = new Date(next.getTime() + intervalMs);
    if (++guard > 100_000) throw new RangeError("averageIntervalDays too small relative to the window");
  }

  while (next <= windowEnd) {
    dates.push(next);
    next = new Date(next.getTime() + intervalMs);
  }

  return dates;
}

export type CashFlowForecastInput = {
  startingBalance: Agorot;
  startDate: Date;
  horizonDays?: number;
  recurringItems: readonly RecurringProjection[];
  /** Signed, typically negative — the average daily net effect of everything that ISN'T a projected recurring item. */
  averageDailyDiscretionarySpend: Agorot;
};

/**
 * Places recurring items (subscriptions, bills, salary) on their actual
 * projected calendar dates, and applies a flat average-daily rate for
 * everything else (ordinary variable/discretionary spending, which can't
 * be pinned to a specific future date the way a subscription can).
 */
export function buildCashFlowForecast(input: CashFlowForecastInput): CashFlowForecast {
  const horizonDays = input.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const windowStart = truncateToDate(input.startDate);
  const windowEnd = addDays(windowStart, horizonDays);

  const eventsByDayOffset = new Map<number, ForecastEvent[]>();
  for (const item of input.recurringItems) {
    const occurrences = projectOccurrenceDates(item.lastOccurredAt, item.averageIntervalDays, windowStart, windowEnd);
    for (const occurrence of occurrences) {
      const dayOffset = Math.round((truncateToDate(occurrence).getTime() - windowStart.getTime()) / DAY_MS);
      const existing = eventsByDayOffset.get(dayOffset) ?? [];
      existing.push({ merchantKey: item.merchantKey, amount: item.amount });
      eventsByDayOffset.set(dayOffset, existing);
    }
  }

  const days: ForecastDay[] = [];
  let balance = input.startingBalance;

  for (let dayOffset = 1; dayOffset <= horizonDays; dayOffset++) {
    const events = eventsByDayOffset.get(dayOffset) ?? [];
    balance = addAgorot(balance, ...events.map((e) => e.amount), input.averageDailyDiscretionarySpend);
    days.push({ date: addDays(windowStart, dayOffset), projectedBalance: balance, events });
  }

  const minimum = days.reduce(
    (min, day) => (day.projectedBalance < min.balance ? { date: day.date, balance: day.projectedBalance } : min),
    { date: days[0].date, balance: days[0].projectedBalance },
  );

  return { days, minimum, endingBalance: days.at(-1)!.projectedBalance };
}

/** Turns a set of historical non-recurring transactions into the flat daily rate `buildCashFlowForecast` needs. */
export function estimateAverageDailyDiscretionarySpend(
  discretionaryAmounts: readonly Agorot[],
  historicalWindowDays: number,
): Agorot {
  if (historicalWindowDays <= 0) {
    throw new RangeError(`historicalWindowDays must be positive, received ${historicalWindowDays}`);
  }
  const total = addAgorot(...discretionaryAmounts);
  return agorot(Math.round(total / historicalWindowDays));
}
