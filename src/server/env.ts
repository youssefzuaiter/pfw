import "server-only";
import * as ReactModule from "react";
import { z } from "zod";

/**
 * The single server-side boundary for reading every secret this app uses
 * (API keys, database URLs, the field-encryption key, and — scaffolding
 * only, see the bottom of this file — future bank-integration API
 * credentials). `import "server-only"` makes this module fail to bundle
 * into any Client Component; every other file that needs one of these
 * values goes through the getters below rather than touching
 * `process.env` directly (`tests/guards/no-public-secrets.test.ts`
 * enforces both of those points at the source level).
 *
 * Every secret is validated with Zod, but *lazily* — one field at a
 * time, only when its getter is actually called — never as a single
 * `schema.parse(process.env)` at module load. That's deliberate, not an
 * oversight: a Phase 2 bug (see AGENTS.md) came from a *different*
 * module eagerly touching `process.env` at import time, which made
 * merely *importing* a file (e.g. so a test's `describe.skipIf(...)`
 * could decide whether to skip itself) throw before the skip condition
 * was ever evaluated. Eagerly parsing a whole-schema here would
 * reintroduce exactly that failure mode for every one of this module's
 * many importers, most of which only ever need one specific value.
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

function isPostgresConnectionString(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "postgres:" || url.protocol === "postgresql:";
  } catch {
    return false;
  }
}

function decodesToExactByteLength(value: string, byteLength: number): boolean {
  try {
    return Buffer.from(value, "base64").length === byteLength;
  } catch {
    return false;
  }
}

const nonEmptyString = (label: string) => z.string().trim().min(1, `${label} must not be empty`);

const postgresConnectionString = (label: string) =>
  nonEmptyString(label).refine(isPostgresConnectionString, {
    message: `${label} must be a well-formed postgres:// or postgresql:// connection string`,
  });

const base64EncodedKey = (label: string, byteLength: number) =>
  nonEmptyString(label).refine((value) => decodesToExactByteLength(value, byteLength), {
    message: `${label} must be base64-encoded and decode to exactly ${byteLength} bytes`,
  });

/** Always-required secrets — every existing deployment (local dev, CI, and Tier 2 hosting) already sets all four. */
const REQUIRED_SECRET_SCHEMAS = {
  ANTHROPIC_API_KEY: nonEmptyString("ANTHROPIC_API_KEY"),
  DATABASE_URL: postgresConnectionString("DATABASE_URL"),
  APP_DATABASE_URL: postgresConnectionString("APP_DATABASE_URL"),
  // AES-256-GCM needs exactly a 256-bit key. field-encryption.ts's own
  // `getKey()` re-checks this same property at the point of actual
  // cryptographic use (defense in depth, same reasoning as the DAL+RLS
  // double-enforcement elsewhere in this app) — validating it here too
  // just means a misconfigured key fails at first *any* secret access,
  // with a clear message, instead of only the first time a field is
  // actually encrypted/decrypted.
  ENCRYPTION_KEY: base64EncodedKey("ENCRYPTION_KEY", 32),
} as const;

type RequiredSecretEnvVar = keyof typeof REQUIRED_SECRET_SCHEMAS;

// Tier 3 scaffolding (docs/SECURITY.md §1) — nothing reads
// `getBankApiCredentials()` yet, since there's no bank-integration
// feature built. Listed here anyway, alongside the vars that ARE live
// today, so the *names* are locked in as secrets from day one: the guard
// test below can never accidentally treat a future bank credential as
// safe-to-expose just because no feature happens to read it yet.
const OPTIONAL_SECRET_ENV_VAR_NAMES = ["BANK_API_CLIENT_ID", "BANK_API_CLIENT_SECRET"] as const;

/**
 * Every env var name this app ever treats as a secret — server-required
 * or optional-future alike. The single source of truth
 * `tests/guards/no-public-secrets.test.ts` imports instead of
 * maintaining its own duplicate list, so a secret added here (the bank
 * API placeholders being the first example) is automatically covered by
 * that guard with no second file to remember to update.
 */
export const SECRET_ENV_VAR_NAMES = [
  ...(Object.keys(REQUIRED_SECRET_SCHEMAS) as RequiredSecretEnvVar[]),
  ...OPTIONAL_SECRET_ENV_VAR_NAMES,
] as const;

function readRequiredEnv(name: RequiredSecretEnvVar): string {
  const raw = process.env[name];
  if (!raw) {
    throw new Error(`Missing required server-only environment variable: ${name}`);
  }

  const result = REQUIRED_SECRET_SCHEMAS[name].safeParse(raw);
  if (!result.success) {
    const reasons = result.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Invalid ${name}: ${reasons}`);
  }

  taintSecret(name, result.data);
  return result.data;
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

export type OllamaConfig = { baseUrl: string; model: string };

/**
 * The local-LLM copilot's Ollama endpoint and model name (AGENTS.md
 * §3o). Not a secret, same reasoning as `getEmbeddingSidecarUrl()` — a
 * local service address and a model name, not a credential — hence a
 * sensible default instead of throwing when unset. `baseUrl` is still
 * independently checked against a loopback/private-address allowlist at
 * the point of use (`src/server/copilot/ollama-client.ts`) before every
 * request, not just trusted here — the copilot's entire premise is that
 * inference never leaves the device, so a misconfigured env var pointing
 * at a real remote host must fail loudly, not silently "work."
 */
export function getOllamaConfig(): OllamaConfig {
  return {
    baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    model: process.env.OLLAMA_MODEL ?? "llama3.1",
  };
}

// === Tier 3 scaffolding: future bank-integration API credentials =========
//
// Preparation for real bank linkage (docs/SECURITY.md §1's Tier 3 —
// Open Banking / Israeli "Open Finance" API, or an equivalent aggregator)
// — NOT wired to any feature yet. No route, DAL function, or adapter
// calls `getBankApiCredentials()` today; it exists purely so the env-var
// *contract* (names, shapes, validation) is decided and enforced now,
// rather than improvised later under deadline pressure once a real
// integration lands. Never a substitute for docs/SECURITY.md §3.3's
// bank-adapter design (Zod-validated canonical rows, formula-injection
// neutralization, idempotent upserts) — this is only the credential
// plumbing a real adapter would eventually authenticate with.

const BankApiCredentialsSchema = z.object({
  clientId: nonEmptyString("BANK_API_CLIENT_ID"),
  clientSecret: nonEmptyString("BANK_API_CLIENT_SECRET"),
  baseUrl: nonEmptyString("BANK_API_BASE_URL").refine(
    (value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: "BANK_API_BASE_URL must be a well-formed URL" },
  ),
});

export type BankApiCredentials = z.infer<typeof BankApiCredentialsSchema>;

/**
 * Returns `null` when unconfigured — the expected state for every
 * environment today, Tier 2 included — so merely importing this module
 * (or calling this getter speculatively) never throws just because bank
 * integration hasn't shipped yet. Throws if only *some* of the three
 * vars are set, since a partial credential is a real misconfiguration,
 * not "not configured yet." `baseUrl` isn't included in
 * `SECRET_ENV_VAR_NAMES` above — an API endpoint URL isn't sensitive on
 * its own, same reasoning as `getEmbeddingSidecarUrl()`.
 */
export function getBankApiCredentials(): BankApiCredentials | null {
  const raw = {
    clientId: process.env.BANK_API_CLIENT_ID,
    clientSecret: process.env.BANK_API_CLIENT_SECRET,
    baseUrl: process.env.BANK_API_BASE_URL,
  };
  const presentCount = Object.values(raw).filter((value) => Boolean(value)).length;
  if (presentCount === 0) return null;
  if (presentCount < 3) {
    throw new Error(
      "BANK_API_CLIENT_ID, BANK_API_CLIENT_SECRET, and BANK_API_BASE_URL must all be set together, or not at all",
    );
  }

  const result = BankApiCredentialsSchema.safeParse(raw);
  if (!result.success) {
    const reasons = result.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Invalid bank API credentials: ${reasons}`);
  }

  taintSecret("BANK_API_CLIENT_ID", result.data.clientId);
  taintSecret("BANK_API_CLIENT_SECRET", result.data.clientSecret);
  return result.data;
}
