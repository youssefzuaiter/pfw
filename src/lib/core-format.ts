import { roundDecimalString } from "./decimal-string";

/**
 * Display text for the long-term core page. Pure and zone-explicit: the
 * page is rendered on the server (Vercel runs in UTC, a laptop in its
 * owner's zone), and a time that silently changes with where it was
 * rendered is worse than one that always says "UTC".
 */

const UTC_DATE_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** `Oct 5, 2026, 13:05 UTC`. */
export function formatUtcDateTime(date: Date): string {
  if (Number.isNaN(date.getTime())) return "—";
  return `${UTC_DATE_TIME.format(date)} UTC`;
}

/** How long ago, in the largest whole unit: `just now`, `5 min`, `3 h`, `2 d`. */
export function formatAge(seconds: number): string {
  if (seconds < 60) return "just now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} h`;
  return `${Math.floor(seconds / 86_400)} d`;
}

/** A span of time (not "ago"): `6 s`, `1 min`, `2 h`, `3 d`. */
export function formatDuration(seconds: number): string {
  const rounded = Math.round(seconds);
  return rounded < 60 ? `${rounded} s` : formatAge(rounded);
}

/** Basis points as a percentage: `1900` is `19.00%`. */
export function formatBps(bps: number | null): string {
  if (bps === null) return "—";
  return `${(bps / 100).toFixed(2)}%`;
}

/** A difference in basis points as percentage points, signed: `+1.00 pp`. */
export function formatSignedBps(bps: number | null): string {
  if (bps === null) return "—";
  const sign = bps > 0 ? "+" : "";
  return `${sign}${(bps / 100).toFixed(2)} pp`;
}

/**
 * A dollar amount the router wrote as a decimal string (a notional, a
 * fill price): `$1,899.81`, `$102.6912`. Grouped, at least two places, at
 * most four (a fill price can have more; nothing here is stored, only
 * shown). Text that is not a plain decimal is returned as it came.
 */
export function formatUsdDecimal(value: string): string {
  const rounded = roundDecimalString(value, 4);
  if (rounded === value && !/^-?\d+(\.\d+)?$/.test(value)) return value;
  const negative = rounded.startsWith("-");
  const [whole, fraction = ""] = (negative ? rounded.slice(1) : rounded).split(".");
  const trimmed = fraction.replace(/0+$/, "").padEnd(2, "0");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${grouped}.${trimmed}`;
}
