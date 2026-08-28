import "server-only";
import * as ReactModule from "react";

/**
 * The single server-side boundary for reading the Anthropic API key and the
 * database URL. `import "server-only"` makes this module fail to bundle
 * into any Client Component; every other file that needs one of these
 * values goes through the getters below rather than touching
 * `process.env` directly.
 */

type ExperimentalReact = {
  experimental_taintUniqueValue?: (
    message: string | undefined,
    lifetime: object,
    value: string,
  ) => void;
};

/**
 * React's taint API (`experimental_taintUniqueValue`) ships only on the
 * React canary/experimental channel — the stable React 19 release this
 * project runs does not export it at runtime (only ambient types exist,
 * under `@types/react/experimental.d.ts`). We deliberately did not move
 * the whole app to the canary channel just for this one guard; see
 * AGENTS.md for the tradeoff. Feature-detecting it here means tainting
 * turns on automatically, with no code change, the moment the project
 * upgrades to a channel that ships it — until then this is a no-op, and
 * `server-only` + the DAL/route-handler boundary carry the guarantee.
 */
function taintSecret(name: string, value: string): void {
  const react = ReactModule as unknown as ExperimentalReact;
  react.experimental_taintUniqueValue?.(
    `Do not pass ${name} to a Client Component — it must stay server-side.`,
    process,
    value,
  );
}

type SecretEnvVar = "ANTHROPIC_API_KEY" | "DATABASE_URL" | "APP_DATABASE_URL" | "ENCRYPTION_KEY";

function readRequiredEnv(name: SecretEnvVar): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required server-only environment variable: ${name}`);
  }
  taintSecret(name, value);
  return value;
}

export function getAnthropicApiKey(): string {
  return readRequiredEnv("ANTHROPIC_API_KEY");
}

/**
 * The admin/migration connection string (the `pfw_app` superuser role) —
 * used only by `prisma.config.ts` and the seed script. Application code
 * must never connect with this; use `getAppDatabaseUrl()` instead, which
 * is the restricted, RLS-subject `pfw_runtime` role.
 */
export function getDatabaseUrl(): string {
  return readRequiredEnv("DATABASE_URL");
}

/**
 * The application runtime connection string (the restricted `pfw_runtime`
 * role) — this is what `src/server/db/client.ts` connects with. See
 * prisma/migrations/*_rls_and_runtime_role for why the two roles exist.
 */
export function getAppDatabaseUrl(): string {
  return readRequiredEnv("APP_DATABASE_URL");
}

export function getEncryptionKey(): string {
  return readRequiredEnv("ENCRYPTION_KEY");
}

/**
 * The merchant-embedding sidecar's base URL (sidecar/, a local FastAPI/
 * ONNX Runtime service — see AGENTS.md). Not a secret — it's a
 * localhost-only service address, not a credential — so this has a
 * sensible local-dev default instead of throwing when unset.
 */
export function getEmbeddingSidecarUrl(): string {
  return process.env.EMBEDDING_SIDECAR_URL ?? "http://localhost:8001";
}
