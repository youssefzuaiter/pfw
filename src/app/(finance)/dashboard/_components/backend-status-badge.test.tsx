import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendStatusBadge } from "./backend-status-badge";

const MINUTE = 60_000;
let hidden = false;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ online: true, outboxPending: 0, paperTradingUser: "ok" }) });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("BackendStatusBadge polling (AGENTS.md §3ssss)", () => {
  it("shows the status, then checks every two minutes rather than every 30 seconds", async () => {
    render(<BackendStatusBadge />);
    await act(async () => void vi.advanceTimersByTime(0));
    expect(screen.getByText("AI Engine Online")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => void vi.advanceTimersByTime(MINUTE));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => void vi.advanceTimersByTime(MINUTE));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops checking once the tab has been left alone for ten minutes", async () => {
    render(<BackendStatusBadge />);
    await act(async () => void vi.advanceTimersByTime(10 * MINUTE));
    fetchMock.mockClear();
    await act(async () => void vi.advanceTimersByTime(60 * MINUTE));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stays quiet in a hidden tab", async () => {
    hidden = true;
    render(<BackendStatusBadge />);
    await act(async () => void vi.advanceTimersByTime(30 * MINUTE));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
