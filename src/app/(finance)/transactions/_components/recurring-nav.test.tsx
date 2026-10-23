import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RecurringNav } from "./recurring-nav";

describe("RecurringNav", () => {
  it("marks the current page and links to the other one", () => {
    render(<RecurringNav active="bills" />);
    expect(screen.getByText("Bills")).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Subscriptions" })).toHaveAttribute("href", "/transactions/subscriptions");
    expect(screen.queryByRole("link", { name: "Bills" })).toBeNull();
  });

  it("does the reverse on the subscriptions page", () => {
    render(<RecurringNav active="subscriptions" />);
    expect(screen.getByText("Subscriptions")).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Bills" })).toHaveAttribute("href", "/transactions/bills");
  });
});
