import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { setCurrencyDisplayMode, toggleCurrencyDisplayMode, useCurrencyDisplayMode } from "./use-currency-display-mode";

/**
 * The Currency UI Toggle's underlying source of truth (Punch List
 * Phase 3, item 2) — same `useSyncExternalStore` + `localStorage` +
 * same-tab-EventTarget pattern already proven for `theme-toggle.tsx`
 * (AGENTS.md §3c), exercised directly here rather than only through the
 * `<CurrencyToggle>`/`<CurrencyAmount>` components that consume it.
 */
describe("useCurrencyDisplayMode", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to 'ils' when nothing is stored yet", () => {
    const { result } = renderHook(() => useCurrencyDisplayMode());
    expect(result.current).toBe("ils");
  });

  it("ignores a garbage stored value and falls back to 'ils'", () => {
    window.localStorage.setItem("pfw-currency-display-mode", "eur");
    const { result } = renderHook(() => useCurrencyDisplayMode());
    expect(result.current).toBe("ils");
  });

  it("reads back an already-stored valid mode on mount", () => {
    window.localStorage.setItem("pfw-currency-display-mode", "native");
    const { result } = renderHook(() => useCurrencyDisplayMode());
    expect(result.current).toBe("native");
  });

  it("toggleCurrencyDisplayMode flips ils <-> native and re-renders every subscribed hook instance", () => {
    const { result } = renderHook(() => useCurrencyDisplayMode());
    expect(result.current).toBe("ils");

    act(() => toggleCurrencyDisplayMode());
    expect(result.current).toBe("native");

    act(() => toggleCurrencyDisplayMode());
    expect(result.current).toBe("ils");
  });

  it("setCurrencyDisplayMode sets an explicit value and persists it to localStorage", () => {
    const { result } = renderHook(() => useCurrencyDisplayMode());

    act(() => setCurrencyDisplayMode("native"));
    expect(result.current).toBe("native");
    expect(window.localStorage.getItem("pfw-currency-display-mode")).toBe("native");
  });

  it("a change made through one hook instance is reflected by a second, independently-mounted instance (same-tab pub/sub)", () => {
    const first = renderHook(() => useCurrencyDisplayMode());
    const second = renderHook(() => useCurrencyDisplayMode());

    act(() => toggleCurrencyDisplayMode());

    expect(first.result.current).toBe("native");
    expect(second.result.current).toBe("native");
  });
});
