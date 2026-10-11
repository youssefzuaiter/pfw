import * as Sentry from "@sentry/nextjs";
import { SENTRY_PRIVACY_OPTIONS } from "./lib/observability/sentry-config";

/**
 * Browser error reporting (Sentry). Inlined at build time, so changing
 * NEXT_PUBLIC_SENTRY_DSN needs a redeploy. Unset = nothing is reported.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn) {
  Sentry.init({ dsn, ...SENTRY_PRIVACY_OPTIONS });
}
