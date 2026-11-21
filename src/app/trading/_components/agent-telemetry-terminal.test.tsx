import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTelemetryTerminal } from "./agent-telemetry-terminal";

let hidden = false;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ online: true, events: [] }) });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AgentTelemetryTerminal polling (AGENTS.md §3ssss)", () => {
  it("refreshes every 10 seconds, not every 4", async () => {
    render(<AgentTelemetryTerminal />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => void vi.advanceTimersByTime(9_000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => void vi.advanceTimersByTime(1_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("pauses when left alone, says so, and refreshes on the next input", async () => {
    render(<AgentTelemetryTerminal />);
    await act(async () => void vi.advanceTimersByTime(10 * 60_000));
    fetchMock.mockClear();

    await act(async () => void vi.advanceTimersByTime(5 * 60_000));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Updates are paused/)).toBeInTheDocument();

    await act(async () => void window.dispatchEvent(new Event("pointerdown")));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Updates are paused/)).not.toBeInTheDocument();
  });
});
