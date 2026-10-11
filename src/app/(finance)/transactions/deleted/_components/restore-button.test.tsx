import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));

const { RestoreButton } = await import("./restore-button");

describe("RestoreButton", () => {
  beforeEach(() => {
    refreshMock.mockReset();
  });

  it("posts the restore request and refreshes the list", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    render(<RestoreButton path="/api/transactions/abc/delete" body={{ deleted: false }} label="Restore" />);
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/transactions/abc/delete",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ deleted: false }) }),
    );
  });

  it("sends an empty JSON body when the endpoint takes none (a whole import)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    render(<RestoreButton path="/api/transactions/import-batch/b1/restore" label="Restore all 211" variant="batch" />);
    fireEvent.click(screen.getByRole("button", { name: "Restore all 211" }));

    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ body: "{}" });
  });

  it("says so and does not refresh when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

    render(<RestoreButton path="/api/transactions/abc/delete" body={{ deleted: false }} label="Restore" />);
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Failed");
    expect(refreshMock).not.toHaveBeenCalled();
    // The button is usable again for a retry.
    expect(screen.getByRole("button", { name: "Restore" })).toBeEnabled();
  });

  it("disables itself while the request is in flight", async () => {
    let finish: (value: { ok: boolean }) => void = () => {};
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise((resolve) => (finish = resolve))));

    render(<RestoreButton path="/api/transactions/abc/delete" body={{ deleted: false }} label="Restore" />);
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    expect(await screen.findByRole("button", { name: "…" })).toBeDisabled();
    finish({ ok: true });
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
  });
});
