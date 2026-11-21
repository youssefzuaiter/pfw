import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let pathname = "/login";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

const { NotificationBell } = await import("./notification-bell");

const MINUTE = 60_000;
let hidden = false;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  pathname = "/login";
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ notifications: [] }) });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("NotificationBell polling (AGENTS.md §3ssss)", () => {
  it("asks once on mount and no longer every 30 seconds", async () => {
    render(<NotificationBell />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => void vi.advanceTimersByTime(4 * MINUTE));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => void vi.advanceTimersByTime(MINUTE));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes the moment the route changes, which is what heals the pre-login 401", async () => {
    const { rerender } = render(<NotificationBell />);
    pathname = "/dashboard";
    rerender(<NotificationBell />);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("makes no requests while the tab is hidden", async () => {
    render(<NotificationBell />);
    fetchMock.mockClear();
    act(() => {
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => void vi.advanceTimersByTime(20 * MINUTE));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
