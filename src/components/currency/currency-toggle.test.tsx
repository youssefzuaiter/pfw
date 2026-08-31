import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { CurrencyToggle } from "./currency-toggle";

describe("CurrencyToggle", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to showing ₪ (ILS) as the active mode", () => {
    render(<CurrencyToggle />);
    expect(screen.getByRole("button")).toHaveTextContent("₪ (ILS)");
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "false");
  });

  it("clicking flips the label to Native currency and sets aria-pressed", () => {
    render(<CurrencyToggle />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("Native currency");
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
  });

  it("clicking twice returns to ₪ (ILS)", () => {
    render(<CurrencyToggle />);
    const button = screen.getByRole("button");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toHaveTextContent("₪ (ILS)");
    expect(button).toHaveAttribute("aria-pressed", "false");
  });

  it("carries a focus-visible ring, same as every other interactive control in this app", () => {
    render(<CurrencyToggle />);
    expect(screen.getByRole("button").className).toMatch(/focus-visible:ring/);
  });
});
