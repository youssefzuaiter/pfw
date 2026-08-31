"use client";

import { useSyncExternalStore } from "react";

/**
 * The Currency UI Toggle (Punch List Phase 3, item 2, amending
 * AGENTS.md §3k/§3l): a single, app-wide preference for whether a
 * foreign-currency figure (a `BankAccount`/`PortfolioHolding`/`Trade`
 * native amount alongside its ILS equivalent) displays the native amount
 * or the ₪ equivalent as the PRIMARY figure. Every screen that renders
 * one of these pairs reads this SAME store via `<CurrencyAmount>`
 * (`src/components/currency/currency-amount.tsx`), so toggling it once
 * (via `<CurrencyToggle>`) changes every such figure across the app
 * consistently, not just the one component the user happened to click.
 *
 * `localStorage`-backed via `useSyncExternalStore`, the exact same
 * pattern `theme-toggle.tsx` already established (AGENTS.md §3c) rather
 * than a Zustand `persist` store — this is a browser-only source of
 * truth with no value during SSR, and `useSyncExternalStore`'s server-
 * snapshot/client-snapshot split is what avoids a hydration-mismatch
 * warning here (a Zustand `persist` store rehydrating AFTER mount would
 * cause exactly that: a visible flash and a real, previously-documented
 * class of bug in this app). The server snapshot is always "ils" (₪
 * primary) — the same figure every screen already showed as primary
 * before this toggle existed, so a not-yet-hydrated client renders
 * identically to what was always there.
 */
export type CurrencyDisplayMode = "native" | "ils";

const STORAGE_KEY = "pfw-currency-display-mode";

// Same-tab pub/sub, same reasoning as theme-toggle.tsx's emitter:
// localStorage's native `storage` event only fires in OTHER tabs, never
// the one that called setItem, so it can't drive this component's own
// re-render on its own toggle click.
const emitter = new EventTarget();
const CHANGE_EVENT = "pfw-currency-display-mode-change";

function isDisplayMode(value: string | null): value is CurrencyDisplayMode {
  return value === "native" || value === "ils";
}

function readStoredMode(): CurrencyDisplayMode {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return isDisplayMode(stored) ? stored : "ils";
}

function subscribe(onChange: () => void) {
  emitter.addEventListener(CHANGE_EVENT, onChange);
  return () => emitter.removeEventListener(CHANGE_EVENT, onChange);
}

function getServerSnapshot(): CurrencyDisplayMode {
  return "ils";
}

export function useCurrencyDisplayMode(): CurrencyDisplayMode {
  return useSyncExternalStore(subscribe, readStoredMode, getServerSnapshot);
}

export function setCurrencyDisplayMode(mode: CurrencyDisplayMode): void {
  window.localStorage.setItem(STORAGE_KEY, mode);
  emitter.dispatchEvent(new Event(CHANGE_EVENT));
}

export function toggleCurrencyDisplayMode(): void {
  setCurrencyDisplayMode(readStoredMode() === "ils" ? "native" : "ils");
}
