import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExportDataPanel } from "./export-data-panel";

/** Settings → Your data (AGENTS.md §3uuu): asks for the chosen format and hands the browser the file under the server's name. */
describe("ExportDataPanel", () => {
  const clicked: string[] = [];

  beforeEach(() => {
    clicked.length = 0;
    URL.createObjectURL = vi.fn(() => "blob:export");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(`${this.download}|${this.href}`);
    });
  });

  it("downloads the chosen format under the name the server gives it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-disposition": 'attachment; filename="pfw-export-2026-10-14.zip"' }),
      blob: async () => new Blob(["zip"]),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ExportDataPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Download CSV (ZIP)" }));

    await waitFor(() => expect(clicked).toEqual(["pfw-export-2026-10-14.zip|blob:export"]));
    expect(fetchMock).toHaveBeenCalledWith("/api/account/export", expect.objectContaining({ method: "POST", body: JSON.stringify({ format: "csv" }) }));
  });

  it("says so when the export is refused, and downloads nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, headers: new Headers() }));
    render(<ExportDataPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Download JSON" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Too many exports. Try again in an hour.");
    expect(clicked).toEqual([]);
  });
});
