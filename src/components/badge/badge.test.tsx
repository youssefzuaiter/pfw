import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "./badge";

describe("Badge", () => {
  it("renders its content", () => {
    render(<Badge variant="positive">Fresh</Badge>);
    expect(screen.getByText("Fresh")).toBeInTheDocument();
  });

  it("applies the critical variant's token classes", () => {
    render(<Badge variant="critical">Stale</Badge>);
    expect(screen.getByText("Stale")).toHaveClass("bg-negative/10", "text-negative");
  });

  it("only adds the pulse animation class when explicitly requested", () => {
    render(<Badge variant="critical">Stale</Badge>);
    expect(screen.getByText("Stale")).not.toHaveClass("uv-badge-pulse");
  });

  it("adds the pulse animation class when pulse is true", () => {
    render(
      <Badge variant="critical" pulse>
        Overdue
      </Badge>,
    );
    expect(screen.getByText("Overdue")).toHaveClass("uv-badge-pulse");
  });
});
