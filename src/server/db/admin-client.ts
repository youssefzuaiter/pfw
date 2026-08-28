import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { getDatabaseUrl } from "../env";
import { withEncryptedFields } from "./encrypted-fields";

/**
 * Admin/migration-role database client — connects as the `pfw_app`
 * superuser and therefore bypasses Row-Level Security entirely (see
 * prisma/migrations/*_rls_and_runtime_role for why superusers always
 * bypass RLS regardless of policy definitions).
 *
 * ONLY the seed script (prisma/seed/) may import this. Application code —
 * routes, Server Components, and everything in src/server/dal — must
 * always go through src/server/db/client.ts + with-user-scope.ts instead,
 * which connect as the restricted `pfw_runtime` role and are subject to
 * RLS. tests/guards/admin-client-boundary.test.ts enforces this.
 */
export function createAdminClient() {
  const adapter = new PrismaPg({ connectionString: getDatabaseUrl() });
  return withEncryptedFields(new PrismaClient({ adapter }));
}
