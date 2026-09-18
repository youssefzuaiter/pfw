"use client";

import { Bell } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Badge } from "../badge/badge";

type NotificationItem = {
  id: string;
  type: string;
  message: string;
  read: boolean;
  createdAt: string;
};

// A real, verified bug this fix closes: `Sidebar` (this component's only
// mount point) lives in the ROOT layout, so it renders on `/login` too
// and does NOT remount across next-auth's client-side-navigated redirect
// to `/dashboard` after a successful sign-in — a mount-once fetch fires
// exactly once, WHILE STILL ON `/login`, gets a correct-but-unhelpful 401
// (not yet authenticated), and then never runs again for the rest of
// that tab's session, even once real notifications exist. Confirmed live
// by tracing every `/api/notifications` request through a real
// login->dashboard flow: two 401s before any reload, two 200s only after
// a hard refresh remounts the tree authenticated. Same fix
// `BackendStatusBadge` already uses for an unrelated reason (its own
// target genuinely changes state over time) — polling here isn't about
// freshness, it's what makes the very next tick after login self-heal
// this exact race, with no special-case "did auth just change" logic
// needed at all.
const POLL_INTERVAL_MS = 30_000;

/**
 * Notification bell, mounted in the sidebar (`Sidebar`, Vercel Cron &
 * Notifications Engine, ad hoc) — polls the caller's own unread
 * `Notification` rows (see the poll-interval comment above for why this
 * is polled rather than fetched once) and lets them be dismissed one at
 * a time. Deliberately a lightweight disclosure popover, not a modal dialog — no
 * full Tab-trap the way `MobileNav`'s "More" drawer needs (`role="dialog"
 * aria-modal`), since this never covers/blocks the rest of the page;
 * Escape-to-close and focus-restore-on-close are still handled, the same
 * baseline this app's other dismissible popovers give. The panel opens
 * left-aligned (`left-0`, not `right-0`) specifically because the trigger
 * sits near the left edge of a narrow sidebar — a right-aligned panel
 * would clip off-screen there. It also opens UPWARD (`bottom-full`, not
 * `top-full`) — the trigger sits near the BOTTOM of the sidebar, and the
 * sidebar itself is a fixed-height, `overflow-y-auto` container, so a
 * panel opening downward would be clipped by that ancestor's own bounds
 * rather than visibly overflowing it (confirmed live: it silently failed
 * to appear at all until this was fixed).
 *
 * `compact` (the collapsed sidebar's own icon-only rail) swaps the
 * "Notifications" text + count `Badge` for a bare bell icon with a small
 * unread-count dot in its corner — same trigger/panel/dismiss logic
 * either way, only the trigger's own contents differ.
 */
export function NotificationBell({ compact = false }: { compact?: boolean }) {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [open, setOpen] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Not used for routing — only as a dependency that changes the instant
  // next-auth's post-login redirect actually lands on a new route, so the
  // effect below re-fetches right then rather than waiting for the next
  // 30s poll tick. `Sidebar` itself never remounts on that redirect (see
  // the comment above), but its `usePathname()` value does change, which
  // is exactly the signal this needs and `Sidebar` doesn't otherwise expose.
  const pathname = usePathname();

  useEffect(() => {
    let cancelled = false;

    async function loadNotifications() {
      try {
        const response = await fetch("/api/notifications", { cache: "no-store" });
        if (cancelled) return;
        if (!response.ok) return; // includes the expected pre-login 401 — the next poll (or navigation) retries
        const body = await response.json();
        if (!cancelled) setNotifications(body.notifications ?? []);
      } catch {
        // Best-effort — a failed poll just means the bell shows nothing
        // until the next tick, same as this app's other silent-best-effort
        // syncs (e.g. the local RAG vector store's own background sync).
      }
    }

    void loadNotifications();
    const interval = setInterval(loadNotifications, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pathname]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    function onPointerDown(event: PointerEvent) {
      if (panelRef.current?.contains(event.target as Node)) return;
      if (triggerRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  // Named handler, not an inline arrow on the button element — the
  // documented focus-visible guard trap (AGENTS.md §3c bug #2, hit
  // repeatedly since).
  function toggleOpen() {
    setOpen((current) => !current);
  }

  async function dismiss(id: string) {
    setDismissError(null);
    try {
      const response = await fetch(`/api/notifications/${id}`, { method: "PATCH" });
      if (!response.ok) {
        setDismissError("Couldn't dismiss that notification — try again.");
        return;
      }
      setNotifications((current) => current.filter((item) => item.id !== id));
    } catch {
      setDismissError("Couldn't dismiss that notification — try again.");
    }
  }

  function handleDismissClick(event: MouseEvent<HTMLButtonElement>) {
    const id = event.currentTarget.dataset.notificationId;
    if (id) void dismiss(id);
  }

  const unreadCount = notifications.length;
  // Hoisted out of the JSX below on purpose: a literal ">" from this
  // comparison sitting inside the compact button's own attribute list
  // (e.g. aria-label={unreadCount > 0 ? ... }) truncates
  // tests/guards/focus-visible.test.ts's regex before it ever reaches
  // that button's className — the same known trap that guard's own doc
  // comment already warns about for an inline "=>", just triggered here
  // by a plain comparison operator instead.
  const hasUnread = unreadCount > 0;

  return (
    <div className="relative">
      {compact ? (
        <button
          ref={triggerRef}
          type="button"
          onClick={toggleOpen}
          aria-haspopup="true"
          aria-expanded={open}
          aria-controls="notification-bell-panel"
          aria-label={hasUnread ? `Notifications (${unreadCount} unread)` : "Notifications"}
          className="relative flex items-center justify-center rounded-md border border-border p-2 text-fg transition-colors hover:bg-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Bell className="h-4 w-4" aria-hidden="true" />
          {hasUnread && (
            <span
              aria-hidden="true"
              className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-negative"
            />
          )}
        </button>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          onClick={toggleOpen}
          aria-haspopup="true"
          aria-expanded={open}
          aria-controls="notification-bell-panel"
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Notifications
          {hasUnread && <Badge variant="critical">{unreadCount}</Badge>}
        </button>
      )}

      {open && (
        <div
          ref={panelRef}
          id="notification-bell-panel"
          role="region"
          aria-label="Notifications"
          className="absolute bottom-full left-0 z-20 mb-2 w-80 rounded-md border border-border bg-bg p-2 shadow-lg"
        >
          {dismissError && <p className="mb-2 px-2 text-xs text-negative">{dismissError}</p>}
          {notifications.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted">No unread notifications.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {notifications.map((notification) => (
                <li
                  key={notification.id}
                  className="flex items-start justify-between gap-2 rounded-md px-2 py-2 text-sm hover:bg-elevated-hover"
                >
                  <span className="text-fg">{notification.message}</span>
                  <button
                    type="button"
                    data-notification-id={notification.id}
                    onClick={handleDismissClick}
                    className="shrink-0 rounded-md px-2 py-0.5 text-xs font-medium text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Dismiss
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
