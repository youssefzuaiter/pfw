import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { getAppDatabaseUrl } from "../env";
import { withEncryptedFields } from "./encrypted-fields";

/**
 * The application's runtime database client. Connects via
 * `APP_DATABASE_URL` — the restricted `pfw_runtime` role, subject to Row-
 * Level Security — never the admin `DATABASE_URL` role that migrations
 * and seeding use. See prisma/migrations/*_rls_and_runtime_role.
 *
 * Every DAL function goes through `withUserScope` (with-user-scope.ts) on
 * top of this client, not this client directly, so the RLS session
 * variable is always set before a query runs.
 */
function createClient() {
  const adapter = new PrismaPg({ connectionString: getAppDatabaseUrl() });
  return withEncryptedFields(new PrismaClient({ adapter }));
}

type ScopedPrismaClient = ReturnType<typeof createClient>;

declare global {
  var __pfwPrismaClient: ScopedPrismaClient | undefined;
}

/**
 * Built lazily, on first actual property access, not at module-import
 * time. This matters beyond tidiness: eagerly constructing the client at
 * import time means merely *importing* a DAL module (e.g. so a test file
 * can decide whether to skip itself) throws if `APP_DATABASE_URL` isn't
 * set, which defeats a `describe.skipIf(!process.env...)` guard entirely
 * — the throw happens during module collection, before the skip
 * condition is ever evaluated. A real failure this caused, not a
 * hypothetical one.
 */
function getClient(): ScopedPrismaClient {
  if (!globalThis.__pfwPrismaClient) {
    globalThis.__pfwPrismaClient = createClient();
  }
  return globalThis.__pfwPrismaClient;
}

export const prisma: ScopedPrismaClient = new Proxy({} as ScopedPrismaClient, {
  get(_target, prop) {
    const client = getClient();
    // Bind methods to the real client, not this proxy — otherwise a
    // caller doing `const { $transaction } = prisma` (extracting the
    // method before calling it) would invoke it with the wrong `this`.
    const value = Reflect.get(client as object, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
