import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));

const { RecurringBillForm } = await import("./recurring-bill-form");

/**
 * The same form serves the Bills page and the Subscriptions page (AGENTS.md
 * §3eeee). Each page sets the kind, the wording follows it, and the kind is
 * what the request carries.
 */
type Call = { url: string; method: string; body: Record<string, unknown> };

function installFetch() {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    }),
  );
  return calls;
}

async function fillAndSubmit(addLabel: string) {
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Something" } });
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "12.50" } });
  fireEvent.click(screen.getByRole("button", { name: addLabel }));
}

describe("RecurringBillForm", () => {
  beforeEach(() => {
    refreshMock.mockClear();
    vi.unstubAllGlobals();
  });

  it("adds a subscription on the Subscriptions page's form", async () => {
    const calls = installFetch();
    render(<RecurringBillForm categories={[]} kind="subscription" />);
    expect(screen.getByLabelText("Name")).toHaveAttribute("placeholder", "Netflix");
    await fillAndSubmit("Save subscription");
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ url: "/api/recurring-bills", method: "POST", body: { kind: "subscription", name: "Something" } });
  });

  it("adds a bill on the Bills page's form, which is the default", async () => {
    const calls = installFetch();
    render(<RecurringBillForm categories={[]} kind="bill" />);
    expect(screen.queryByRole("button", { name: "Save subscription" })).toBeNull();
    await fillAndSubmit("Save bill");
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toMatchObject({ kind: "bill" });
  });

  it("does not send a kind when editing, so an item cannot move between pages", async () => {
    const calls = installFetch();
    render(
      <RecurringBillForm
        categories={[]}
        bill={{ id: "b1", kind: "subscription", name: "Netflix", amount: "49.90", amountVaries: false, currency: "ILS", cadence: "monthly", anchorDate: "2026-10-01", categoryId: null }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ url: "/api/recurring-bills/b1", method: "PATCH" });
    expect(calls[0].body).not.toHaveProperty("kind");
  });

  it("sends a fixed amount by default, and marks the amount as varying when the box is ticked", async () => {
    const calls = installFetch();
    render(<RecurringBillForm categories={[]} kind="bill" />);
    expect(screen.getByLabelText("Amount")).toBeInTheDocument();
    expect(screen.getByLabelText("The amount is different every time")).not.toBeChecked();
    await fillAndSubmit("Save bill");
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toMatchObject({ amountVaries: false });
  });

  it("asks for a typical amount once the amount varies, and sends that", async () => {
    const calls = installFetch();
    render(<RecurringBillForm categories={[]} kind="bill" />);
    fireEvent.click(screen.getByLabelText("The amount is different every time"));
    expect(screen.getByLabelText("Typical amount")).toBeInTheDocument();
    expect(screen.queryByLabelText("Amount")).toBeNull();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Electricity" } });
    fireEvent.change(screen.getByLabelText("Typical amount"), { target: { value: "300" } });
    fireEvent.click(screen.getByRole("button", { name: "Save bill" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toMatchObject({ name: "Electricity", amount: "300", amountVaries: true });
  });

  it("opens an existing varying bill with the box ticked, and can switch it back to a fixed amount", async () => {
    const calls = installFetch();
    render(
      <RecurringBillForm
        categories={[]}
        bill={{ id: "b2", kind: "bill", name: "Water", amount: "80.00", amountVaries: true, currency: "ILS", cadence: "monthly", anchorDate: "2026-10-01", categoryId: null }}
      />,
    );
    const box = screen.getByLabelText("The amount is different every time");
    expect(box).toBeChecked();
    fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ url: "/api/recurring-bills/b2", method: "PATCH" });
    expect(calls[0].body).toMatchObject({ amountVaries: false });
  });
});
