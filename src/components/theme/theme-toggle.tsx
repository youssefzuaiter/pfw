"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";

type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "pfw-theme";
const ORDER: readonly ThemePreference[] = ["system", "light", "dark"];
const LABEL: Record<ThemePreference, string> = { system: "System", light: "Light", dark: "Dark" };
const ICON: Record<ThemePreference, typeof Monitor> = { system: Monitor, light: Sun, dark: Moon };

// A same-tab pub/sub for the toggle's own change: `localStorage`'s native
// `storage` event only fires in *other* tabs/windows, never the one that
// called setItem, so it can't drive this component's own re-render.
const emitter = new EventTarget();
const CHANGE_EVENT = "pfw-theme-change";

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function applyTheme(preference: ThemePreference): void {
  if (preference === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", preference);
  }
}

function readStoredPreference(): ThemePreference {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return isThemePreference(stored) ? stored : "system";
}

function subscribe(onChange: () => void) {
  emitter.addEventListener(CHANGE_EVENT, onChange);
  return () => emitter.removeEventListener(CHANGE_EVENT, onChange);
}

function getServerSnapshot(): ThemePreference {
  return "system";
}

/**
 * Cycles System -> Light -> Dark -> System. `useSyncExternalStore` (not
 * an effect + setState) is what correctly synchronizes to a browser-only
 * source of truth here: the server snapshot is always "system" (there's
 * no localStorage during SSR), and the real value is read as soon as the
 * client subscribes — no hydration-mismatch warning, no
 * effect-triggers-a-render lint violation. The *page's* colors don't have
 * this problem at all: theme-init-script.tsx applies the stored theme
 * before first paint, blocking-script style — this component only needs
 * to reflect the current preference in its own label.
 *
 * `compact` (the collapsed sidebar's own icon-only rail) swaps the text
 * label for the matching Monitor/Sun/Moon icon — same `cycle()` behavior
 * and the same `aria-label`, so a screen reader gets identical
 * information either way.
 */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const preference = useSyncExternalStore(subscribe, readStoredPreference, getServerSnapshot);

  function cycle() {
    const next = ORDER[(ORDER.indexOf(preference) + 1) % ORDER.length];
    window.localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
    emitter.dispatchEvent(new Event(CHANGE_EVENT));
  }

  if (compact) {
    const Icon = ICON[preference];
    return (
      <button
        type="button"
        onClick={cycle}
        className="uv-btn-press flex items-center justify-center rounded-md border border-border p-2 text-fg transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Theme: ${LABEL[preference]}. Click to change.`}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={cycle}
      className="uv-btn-press rounded-md border border-border px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`Theme: ${LABEL[preference]}. Click to change.`}
    >
      {LABEL[preference]}
    </button>
  );
}
