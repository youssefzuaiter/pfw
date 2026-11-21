import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePolling, type UsePollingOptions } from "./use-polling";

function Probe({ poll, options }: { poll: () => void; options: UsePollingOptions }) {
  usePolling(poll, options);
  return null;
}

let hidden = false;

function setHidden(value: boolean) {
  hidden = value;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
});

afterEach(() => {
  vi.useRealTimers();
});

const MINUTE = 60_000;

describe("usePolling", () => {
  it("polls once on mount and then on every interval while the tab is visible and in use", () => {
    const poll = vi.fn();
    render(<Probe poll={poll} options={{ intervalMs: 30_000, idleAfterMs: 10 * MINUTE }} />);
    expect(poll).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(30_000));
    expect(poll).toHaveBeenCalledTimes(2);
    act(() => void vi.advanceTimersByTime(60_000));
    expect(poll).toHaveBeenCalledTimes(4);
  });

  it("makes no request while the tab is hidden, and refreshes once when it comes back", () => {
    const poll = vi.fn();
    render(<Probe poll={poll} options={{ intervalMs: 30_000 }} />);
    poll.mockClear();

    act(() => setHidden(true));
    act(() => void vi.advanceTimersByTime(5 * MINUTE));
    expect(poll).not.toHaveBeenCalled();

    act(() => setHidden(false));
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("does not poll at all when mounted in a hidden tab, until it becomes visible", () => {
    hidden = true;
    const poll = vi.fn();
    render(<Probe poll={poll} options={{ intervalMs: 30_000 }} />);
    act(() => void vi.advanceTimersByTime(2 * MINUTE));
    expect(poll).not.toHaveBeenCalled();

    act(() => setHidden(false));
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("stops after the idle limit with no input, and refreshes once on the next input", () => {
    const poll = vi.fn();
    render(<Probe poll={poll} options={{ intervalMs: MINUTE, idleAfterMs: 5 * MINUTE }} />);
    act(() => void vi.advanceTimersByTime(5 * MINUTE));
    poll.mockClear();

    act(() => void vi.advanceTimersByTime(30 * MINUTE));
    expect(poll).not.toHaveBeenCalled();

    act(() => void window.dispatchEvent(new Event("pointerdown")));
    expect(poll).toHaveBeenCalledTimes(1);

    // And it keeps going while the person keeps using the page.
    act(() => void vi.advanceTimersByTime(MINUTE));
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("input keeps a tab from going idle", () => {
    const poll = vi.fn();
    render(<Probe poll={poll} options={{ intervalMs: MINUTE, idleAfterMs: 5 * MINUTE }} />);
    for (let i = 0; i < 10; i++) {
      act(() => void vi.advanceTimersByTime(MINUTE));
      act(() => void window.dispatchEvent(new Event("keydown")));
    }
    poll.mockClear();
    act(() => void vi.advanceTimersByTime(MINUTE));
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("refreshes straight away when the trigger key changes", () => {
    const poll = vi.fn();
    const { rerender } = render(<Probe poll={poll} options={{ intervalMs: 5 * MINUTE, triggerKey: "/login" }} />);
    expect(poll).toHaveBeenCalledTimes(1);
    rerender(<Probe poll={poll} options={{ intervalMs: 5 * MINUTE, triggerKey: "/dashboard" }} />);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("always calls the latest poll function", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Probe poll={first} options={{ intervalMs: MINUTE }} />);
    rerender(<Probe poll={second} options={{ intervalMs: MINUTE }} />);
    act(() => void vi.advanceTimersByTime(MINUTE));
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1); // only the mount poll
  });

  it("reports pausing and resuming, once each", () => {
    const onPausedChange = vi.fn();
    render(<Probe poll={vi.fn()} options={{ intervalMs: MINUTE, idleAfterMs: 5 * MINUTE, onPausedChange }} />);

    act(() => void vi.advanceTimersByTime(10 * MINUTE));
    expect(onPausedChange.mock.calls).toEqual([[true]]);

    act(() => void window.dispatchEvent(new Event("pointerdown")));
    expect(onPausedChange.mock.calls).toEqual([[true], [false]]);
  });

  it("clears its timer and listeners on unmount", () => {
    const poll = vi.fn();
    const { unmount } = render(<Probe poll={poll} options={{ intervalMs: MINUTE }} />);
    unmount();
    poll.mockClear();
    act(() => void vi.advanceTimersByTime(10 * MINUTE));
    act(() => void window.dispatchEvent(new Event("pointerdown")));
    expect(poll).not.toHaveBeenCalled();
  });
});
