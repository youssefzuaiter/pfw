import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Spinner } from "./spinner";

describe("Spinner", () => {
  it("exposes an accessible loading status", () => {
    render(<Spinner />);
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
  });

  it("defaults to the small size", () => {
    render(<Spinner />);
    expect(screen.getByRole("status")).toHaveClass("h-3.5", "w-3.5");
  });

  it("supports the medium size", () => {
    render(<Spinner size="md" />);
    expect(screen.getByRole("status")).toHaveClass("h-5", "w-5");
  });
});
