"use client";

import { ChevronLeft, ChevronRight, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { NotificationBell } from "../notifications/notification-bell";
import { isNavItemActive, PRIMARY_NAV_ITEMS } from "./nav-items";
import { SignOutButton } from "./sign-out-button";

const STORAGE_KEY = "pfw-sidebar-collapsed";

// A same-tab pub/sub, needed because `localStorage`'s own `storage`
// event only fires in OTHER tabs, never
// the one that called `setItem`, so a same-tab collapse toggle needs its
// own emitter to re-render.
const emitter = new EventTarget();
const CHANGE_EVENT = "pfw-sidebar-collapse-change";

function readCollapsed(): boolean {
  return window.localStorage.getItem(STORAGE_KEY) === "true";
}

function subscribe(onChange: () => void) {
  emitter.addEventListener(CHANGE_EVENT, onChange);
  return () => emitter.removeEventListener(CHANGE_EVENT, onChange);
}

// Expanded is the server snapshot — "fail toward what was always there":
// a not-yet-hydrated client renders the sidebar exactly as it always
// looked before this toggle existed, never a guessed collapsed state.
function getServerSnapshot(): boolean {
  return false;
}

function setCollapsed(value: boolean): void {
  window.localStorage.setItem(STORAGE_KEY, String(value));
  emitter.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * Desktop-only (`md:` breakpoint and up) left-hand navigation rail — see
 * `MobileNav` for the small-screen equivalent (a bottom tab bar).
 * Collapsible (persisted in `localStorage`, `useSyncExternalStore` for
 * reactivity with no hydration-mismatch) so the full-width rail isn't a
 * permanent tax on every screen's usable width. Every nav item, Settings,
 * Notifications, and Sign out all render an icon (`lucide-react`) at all
 * times; collapsing only hides the TEXT labels (kept as a native `title`
 * tooltip + `sr-only` span) — nothing is hidden or unreachable while
 * collapsed.
 *
 * No theme toggle here (removed, along with the System/Light/Dark
 * switching mechanism entirely — `globals.css` now ships one permanent
 * theme, at explicit user request, once the institutional-terminal pass
 * had already hardcoded most screens to fixed `slate-*`/`neutral-*`
 * classes anyway, leaving almost nothing left for a toggle to actually
 * switch).
 */
export function Sidebar() {
  const pathname = usePathname();
  const collapsed = useSyncExternalStore(subscribe, readCollapsed, getServerSnapshot);

  function handleToggleCollapse() {
    setCollapsed(!collapsed);
  }

  const settingsActive = isNavItemActive(pathname, "/settings");

  // `/trading` renders its own dedicated dark/monospace shell
  // (`src/app/trading/layout.tsx`) with its own thin icon sidebar — the
  // standard sidebar would visually clash with it and would also
  // duplicate the trading desk's own view-switching tabs.
  if (pathname?.startsWith("/trading")) return null;

  return (
    <aside
      className={`sticky top-0 hidden h-screen shrink-0 flex-col overflow-y-auto border-r border-slate-800 bg-slate-950 transition-[width] duration-150 md:flex ${
        collapsed ? "w-16" : "w-64"
      }`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 p-4">
        {!collapsed && (
          <Link
            href="/dashboard"
            className="rounded-md font-display text-lg font-semibold tracking-tight text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            PFW
          </Link>
        )}
        <button
          type="button"
          onClick={handleToggleCollapse}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="flex items-center justify-center rounded-md p-1.5 text-slate-500 hover:bg-slate-700 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          {collapsed ? <ChevronRight className="h-4 w-4" aria-hidden="true" /> : <ChevronLeft className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>
      <nav aria-label="Primary" className="flex flex-1 flex-col gap-1 p-3">
        {PRIMARY_NAV_ITEMS.map((item) => {
          const active = isNavItemActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              title={collapsed ? item.label : undefined}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                active ? "bg-slate-800 text-sky-400" : "text-slate-500 hover:bg-slate-700 hover:text-slate-100"
              } ${collapsed ? "justify-center" : ""}`}
            >
              <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
              {collapsed ? <span className="sr-only">{item.label}</span> : item.label}
            </Link>
          );
        })}
      </nav>
      <div className="flex flex-col gap-3 border-t border-slate-800 p-3">
        <Link
          href="/settings"
          aria-current={settingsActive ? "page" : undefined}
          title={collapsed ? "Settings" : undefined}
          className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
            settingsActive ? "bg-slate-800 text-sky-400" : "text-slate-500 hover:bg-slate-700 hover:text-slate-100"
          } ${collapsed ? "justify-center" : ""}`}
        >
          <Settings className="h-5 w-5 shrink-0" aria-hidden="true" />
          {collapsed ? <span className="sr-only">Settings</span> : "Settings"}
        </Link>
        <div className={collapsed ? "flex flex-col items-center gap-2" : "flex items-center justify-between px-1"}>
          <NotificationBell compact={collapsed} />
          <SignOutButton variant={collapsed ? "icon" : "nav"} />
        </div>
      </div>
    </aside>
  );
}
