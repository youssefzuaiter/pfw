import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/rag/local-retrieval", () => ({ retrieveRelevantTransactionIds: vi.fn().mockResolvedValue([]) }));
vi.mock("../../lib/rag/local-vector-store", () => ({ syncLocalVectorStore: vi.fn().mockResolvedValue(undefined) }));

const { CopilotSidebar } = await import("./copilot-sidebar");

/**
 * Opening and closing the copilot panel. The floating launcher is hidden
 * while the panel is open (on a phone it covered the message box and the
 * Send button), so focus has to move into the panel and back, and Escape
 * has to close it.
 */
describe("CopilotSidebar", () => {
  beforeEach(() => {
    // jsdom has no scrollIntoView; the panel calls it to keep the newest message in view.
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ available: false, reason: "not running" }) }));
  });

  function launcher() {
    return screen.getByRole("button", { name: "Copilot" });
  }

  it("hides the launcher while open and puts focus on the panel's close button", () => {
    render(<CopilotSidebar />);
    fireEvent.click(launcher());

    expect(launcher().className).toContain("hidden");
    expect(launcher().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close copilot" }));
  });

  it("closes on Escape and gives focus back to the launcher", () => {
    render(<CopilotSidebar />);
    fireEvent.click(launcher());
    fireEvent.keyDown(document, { key: "Escape" });

    expect(launcher().className).not.toContain("hidden");
    expect(launcher().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(launcher());
  });

  it("closes from the panel's own close button too", () => {
    render(<CopilotSidebar />);
    fireEvent.click(launcher());
    fireEvent.click(screen.getByRole("button", { name: "Close copilot" }));

    expect(document.activeElement).toBe(launcher());
    expect(document.getElementById("copilot-panel")?.hasAttribute("inert")).toBe(true);
  });

  it("does not grab focus on first render", () => {
    render(<CopilotSidebar />);
    expect(document.activeElement).toBe(document.body);
  });
});
