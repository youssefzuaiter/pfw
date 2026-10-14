import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PhoneAlertsPanel } from "./phone-alerts-panel";

function respond(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

const ON = { topicHint: "…c123", largeExpenseAgorot: 100_000, includeDetails: true };

describe("PhoneAlertsPanel", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("says where alerts go before anything is turned on", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<PhoneAlertsPanel initial={null} />);
    expect(screen.getByText(/anyone who knows the topic can read the messages/)).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("turns alerts on with a generated topic and shows it once", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond({ ...ON, topicHint: "…wxyz", topic: "pfw-generated-wxyz" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PhoneAlertsPanel initial={null} />);

    fireEvent.click(screen.getByRole("button", { name: "Turn on phone alerts" }));
    expect(await screen.findByText("pfw-generated-wxyz")).toBeTruthy();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({});
    expect(screen.getByText("…wxyz")).toBeTruthy();
  });

  it("refuses a bad topic without calling the server", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<PhoneAlertsPanel initial={null} />);

    fireEvent.change(screen.getByLabelText(/Your own topic/), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Turn on phone alerts" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/12–64 letters/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never shows the full topic again once set, only its ending", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<PhoneAlertsPanel initial={ON} />);
    expect(screen.getByText("…c123")).toBeTruthy();
    expect(screen.getByLabelText(/at least \(₪\)/)).toHaveProperty("value", "1000");
  });

  it("saves the threshold in shekels and the details switch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond({ ...ON, largeExpenseAgorot: 250_050, includeDetails: false }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PhoneAlertsPanel initial={ON} />);

    fireEvent.change(screen.getByLabelText(/at least \(₪\)/), { target: { value: "2500.50" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Include merchant names/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/phone-alerts");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ largeExpense: "2500.50", includeDetails: false });
  });

  it("shows ntfy's reason when the test alert fails, and turns alerts off", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond({ error: "The test alert was not delivered: ntfy.sh answered 500." }, false))
      .mockResolvedValueOnce(respond({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PhoneAlertsPanel initial={ON} />);

    fireEvent.click(screen.getByRole("button", { name: "Send test alert" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/ntfy.sh answered 500/);

    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    expect(await screen.findByRole("button", { name: "Turn on phone alerts" })).toBeTruthy();
    expect(fetchMock.mock.calls[1][1].method).toBe("DELETE");
  });
});
