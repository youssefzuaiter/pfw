import type { ErrorEvent } from "@sentry/nextjs";

/**
 * Last line of defence before an error report leaves the app (AGENTS.md
 * §1 law #6 and §2: this app holds bank and transaction data, and an error
 * report is a copy of that data sent to a third party).
 *
 * Keeps what a developer needs to find the bug — the error's type, its stack
 * (file and function names) and the route path — and drops everything that
 * can carry a person's data: query strings, headers, cookies, request bodies,
 * user details, breadcrumbs, extra context, and the values of local
 * variables in stack frames.
 *
 * Error messages are the hard part. Prisma's messages embed the query's
 * arguments, so a message containing a transaction description, an amount or
 * an email would leak through a plain copy. A message is therefore kept only
 * when it is plain prose: letters, spaces and light punctuation, no quotes,
 * braces, backticks, digits, newlines or "@". Anything else is replaced.
 */
const SAFE_MESSAGE = /^[A-Za-z][A-Za-z ,.:()_-]{0,199}$/;
const REDACTED = "[redacted]";

export function safeMessage(text: string): string {
  return SAFE_MESSAGE.test(text) ? text : REDACTED;
}

function routePathOnly(url: string): string | undefined {
  try {
    return new URL(url, "http://localhost").pathname;
  } catch {
    return undefined;
  }
}

export function scrubSentryEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    const path = event.request.url ? routePathOnly(event.request.url) : undefined;
    event.request = path ? { url: path, method: event.request.method } : undefined;
  }

  delete event.user;
  delete event.extra;
  delete event.contexts;
  delete event.breadcrumbs;
  delete event.server_name;

  if (event.message) event.message = safeMessage(event.message);

  for (const value of event.exception?.values ?? []) {
    if (value.value) value.value = safeMessage(value.value);
    for (const frame of value.stacktrace?.frames ?? []) {
      delete frame.vars;
    }
  }

  return event;
}
