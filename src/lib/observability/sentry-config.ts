import { scrubSentryEvent } from "./scrub-sentry-event";

/**
 * Integrations removed by name, because each would send data this app must
 * not send:
 * - Breadcrumbs / Console / Http / NodeFetch: a history of console output and
 *   outgoing request URLs, which can include query strings and record data.
 * - RequestData: request headers, cookies and bodies.
 * - LocalVariables / LocalVariablesAsync: the values of local variables at the
 *   point an error was thrown, which is where transaction data lives.
 * - Replay: session replay records the page itself.
 * The cost is that reports carry no "steps before the error" trail. That is
 * the deliberate trade for an app that holds financial data.
 */
const EXCLUDED_INTEGRATIONS = new Set([
  "Breadcrumbs",
  "Console",
  "Http",
  "NodeFetch",
  "RequestData",
  "LocalVariables",
  "LocalVariablesAsync",
  "Replay",
]);

export const SENTRY_PRIVACY_OPTIONS = {
  sendDefaultPii: false,
  tracesSampleRate: 0,
  beforeSend: scrubSentryEvent,
  beforeBreadcrumb: () => null,
  integrations: (defaults: { name: string }[]) => defaults.filter((i) => !EXCLUDED_INTEGRATIONS.has(i.name)),
} as const;
