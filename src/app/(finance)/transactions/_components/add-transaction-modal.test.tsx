import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));
vi.mock("../../../../lib/embeddings/local-embedder", () => ({ embedTextWithTimeout: async () => undefined }));

const { AddTransactionModal } = await import("./add-transaction-modal");

/**
 * Entering an amount in a chosen currency (AGENTS.md §3www): the picker
 * defaults to the account's currency, the exact shekel figure is shown
 * before submitting, and that figure is what the request asks the server
 * to store.
 */
const ACCOUNTS = [
  { id: "acc-ils", label: "Leumi ••1234", currency: "ILS" as const },
  { id: "acc-try", label: "QNB ••7669", currency: "TRY" as const },
];

const RATES: Record<string, { micros: number; rate: string; rateDay: string }> = {
  USD: { micros: 3_037_667, rate: "3.037667", rateDay: "2026-10-09" },
  TRY: { micros: 62_267, rate: "0.062267", rateDay: "2026-10-09" },
};

type Call = { url: string; body?: Record<string, unknown> };

function installFetch(createResponses: Array<{ status: number; body: Record<string, unknown> }> = [{ status: 201, body: { ok: true } }]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.startsWith("/api/exchange-rates/on")) {
        const params = new URL(url, "http://localhost").searchParams;
        const rate = RATES[params.get("currency") ?? ""];
        return { ok: true, status: 200, json: async () => ({ ...rate, day: params.get("day") }) };
      }
      const next = createResponses.shift() ?? { status: 201, body: { ok: true } };
      return { ok: next.status < 300, status: next.status, json: async () => next.body };
    }),
  );
  return calls;
}

function openForm() {
  render(<AddTransactionModal bankAccounts={ACCOUNTS} />);
  fireEvent.click(screen.getByRole("button", { name: "Add transaction" }));
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Books" } });
  fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-10-11" } });
}

describe("AddTransactionModal in a chosen currency", () => {
  beforeEach(() => {
    refreshMock.mockReset();
  });

  it("starts in the account's currency and switches with the account", () => {
    installFetch();
    openForm();
    expect(screen.getByLabelText("Currency")).toHaveValue("ILS");
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "acc-try" } });
    expect(screen.getByLabelText("Currency")).toHaveValue("TRY");
    expect(screen.getByLabelText("Amount (₺)")).toBeInTheDocument();
  });

  it("shows the exact shekel figure and the locked rate before anything is saved", async () => {
    installFetch();
    openForm();
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "USD" } });
    fireEvent.change(screen.getByLabelText("Amount ($)"), { target: { value: "49.90" } });
    expect(await screen.findByText("Records as ₪151.58 at ₪3.037667 per $1, rate of 2026-10-09.")).toBeInTheDocument();
  });

  it("sends the entered amount, its currency, and the shekel figure it showed", async () => {
    const calls = installFetch();
    openForm();
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "USD" } });
    fireEvent.change(screen.getByLabelText("Amount ($)"), { target: { value: "49.90" } });
    await screen.findByText(/Records as ₪151\.58/);
    fireEvent.click(screen.getAllByRole("button", { name: "Add transaction" }).at(-1)!);

    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    const create = calls.find((call) => call.url === "/api/transactions");
    expect(create?.body).toMatchObject({ amount: "-49.90", currency: "USD", expectedAmountAgorot: "-15158", occurredAt: "2026-10-11T00:00:00.000Z" });
  });

  it("asks for the rate again and shows the server's message when the rate changed", async () => {
    const calls = installFetch([{ status: 409, body: { code: "rate_changed", error: "The exchange rate changed since the preview." } }]);
    openForm();
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "USD" } });
    fireEvent.change(screen.getByLabelText("Amount ($)"), { target: { value: "49.90" } });
    await screen.findByText(/Records as ₪151\.58/);
    fireEvent.click(screen.getAllByRole("button", { name: "Add transaction" }).at(-1)!);

    expect(await screen.findByText("The exchange rate changed since the preview.")).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((call) => call.url.startsWith("/api/exchange-rates/on"))).toHaveLength(2));
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("books shekels with no rate lookup at all", async () => {
    const calls = installFetch();
    openForm();
    fireEvent.change(screen.getByLabelText("Amount (₪)"), { target: { value: "125.50" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Add transaction" }).at(-1)!);
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    expect(calls.some((call) => call.url.startsWith("/api/exchange-rates/on"))).toBe(false);
    expect(calls.find((call) => call.url === "/api/transactions")?.body).toMatchObject({ amount: "-125.50", currency: "ILS" });
  });
});
