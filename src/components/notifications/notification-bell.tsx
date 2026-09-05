"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Badge } from "../badge/badge";

type NotificationItem = {
  id: string;
  type: string;
  message: string;
  read: boolean;
  createdAt: string;
};

/**
 * Dashboard header notification bell (Vercel Cron & Notifications Engine,
 * ad hoc) — fetches the caller's own unread `Notification` rows on mount
 * and lets them be dismissed one at a time. Deliberately a lightweight
 * disclosure popover, not a modal dialog — no full Tab-trap the way
 * `MobileNav`'s "More" drawer needs (`role="dialog" aria-modal`), since
 * this never covers/blocks the rest of the page; Escape-to-close and
 * focus-restore-on-close are still handled, the same baseline this app's
 * other dismissible popovers give.
 */
export function NotificationBell() {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [open, setOpen] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadNotifications() {
      try {
        const response = await fetch("/api/notifications");
        if (!response.ok) return;
        const body = await response.json();
        if (!cancelled) setNotifications(body.notifications ?? []);
      } catch {
        // Best-effort — a failed fetch just means the bell shows nothing
        // this load, same as this app's other silent-best-effort syncs
        // (e.g. the local RAG vector store's own background sync).
      }
    }

    void loadNotifications();
    return () => {
      cancelled = true;
    };
  }, []);

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

  return (
    <div className="relative">
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
        {unreadCount > 0 && <Badge variant="critical">{unreadCount}</Badge>}
      </button>

      {open && (
        <div
          ref={panelRef}
          id="notification-bell-panel"
          role="region"
          aria-label="Notifications"
          className="absolute right-0 z-20 mt-2 w-80 rounded-md border border-border bg-surface p-2 shadow-lg"
        >
          {dismissError && <p className="mb-2 px-2 text-xs text-negative">{dismissError}</p>}
          {notifications.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted">No unread notifications.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {notifications.map((notification) => (
                <li
                  key={notification.id}
                  className="flex items-start justify-between gap-2 rounded-md px-2 py-2 text-sm hover:bg-border/40"
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
