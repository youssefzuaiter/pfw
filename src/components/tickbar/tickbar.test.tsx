import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Tickbar } from "./tickbar";

describe("Tickbar", () => {
  it("exposes the percentage as an accessible progressbar, not color-only", () => {
    render(<Tickbar label="Groceries" percent={45} status="good" />);
    const bar = screen.getByRole("progressbar", { name: "Groceries" });
    expect(bar).toHaveAttribute("aria-valuenow", "45");
    expect(screen.getByText("45%")).toBeInTheDocument();
  });

  it("clamps a percentage over 100 for the visual fill but still reports the real number in text", () => {
    render(<Tickbar label="Dining" percent={140} status="critical" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByText("140%")).toBeInTheDocument();
  });

  it("clamps a negative percentage to zero", () => {
    render(<Tickbar label="Weird" percent={-10} status="good" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  });
});
