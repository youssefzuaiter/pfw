import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The real HeroCanvas needs a WebGL-capable environment (see
// hero-canvas.test.tsx) — this page-level test only cares that the page
// wires it in and offers a way into the real app, not how it renders.
vi.mock("../../components/hero/hero-canvas", () => ({
  HeroCanvas: () => <div>stub-hero-canvas</div>,
}));

const { default: WelcomePage } = await import("./page");

describe("WelcomePage", () => {
  it("renders a headline and a link into the dashboard", () => {
    render(<WelcomePage />);

    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    const cta = screen.getByRole("link", { name: /enter dashboard/i });
    expect(cta).toHaveAttribute("href", "/dashboard");
  });

  it("mounts the hero canvas", () => {
    render(<WelcomePage />);
    expect(screen.getByText("stub-hero-canvas")).toBeInTheDocument();
  });
});
