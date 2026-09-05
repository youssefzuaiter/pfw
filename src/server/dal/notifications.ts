import "server-only";
import { withUserScope } from "../db/with-user-scope";

/**
 * DAL for `Notification` (Vercel Cron & Notifications Engine, ad hoc) —
 * the dashboard header bell's read/dismiss surface. Strictly personal,
 * standard `tenant_isolation` RLS (see the model's own schema comment).
 */

export type NotificationSummary = {
  id: string;
  type: string;
  message: string;
  read: boolean;
  createdAt: Date;
};

const UNREAD_LIST_LIMIT = 20;

export async function listUnreadNotifications(userId: string): Promise<NotificationSummary[]> {
  const rows = await withUserScope(userId, (tx) =>
    tx.notification.findMany({
      where: { userId, read: false },
      orderBy: { createdAt: "desc" },
      take: UNREAD_LIST_LIMIT,
    }),
  );
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    message: row.message,
    read: row.read,
    createdAt: row.createdAt,
  }));
}

/** IDOR-safe: `updateMany` with both `id` AND `userId` in the `where` — a nonexistent or someone-else's id updates 0 rows rather than leaking existence. */
export async function dismissNotification(userId: string, id: string): Promise<boolean> {
  const result = await withUserScope(userId, (tx) =>
    tx.notification.updateMany({ where: { id, userId }, data: { read: true } }),
  );
  return result.count > 0;
}
