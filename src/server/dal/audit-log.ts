import "server-only";
import type { Prisma } from "../../generated/prisma/client";
import { withUserScope } from "../db/with-user-scope";

type AuditLogEntry = {
  entityType: string;
  entityId: string;
  action: "CREATE" | "UPDATE" | "DELETE";
  beforeData?: Prisma.InputJsonValue;
  afterData?: Prisma.InputJsonValue;
};

/**
 * The only way anything in this codebase writes to AuditLog — there is no
 * update/delete counterpart, by design (see the model's doc comment in
 * schema.prisma and the append-only trigger in
 * prisma/migrations/*_rls_and_runtime_role).
 */
export async function recordAuditLog(userId: string, entry: AuditLogEntry) {
  return withUserScope(userId, (tx) =>
    tx.auditLog.create({
      data: {
        userId,
        entityType: entry.entityType,
        entityId: entry.entityId,
        action: entry.action,
        beforeData: entry.beforeData,
        afterData: entry.afterData,
      },
    }),
  );
}
