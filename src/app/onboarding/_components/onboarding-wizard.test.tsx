import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshMock = vi.fn();
const pushMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock, push: pushMock }) }));

const { OnboardingWizard } = await import("./onboarding-wizard");

/**
 * The wizard's job is order, escape hatches and recording completion; the
 * forms inside it are the real ones the Assets and Transactions pages use, so
 * these tests drive them rather than stand-ins.
 */
type Call = { url: string; method: string; body?: Record<string, unknown> };

function installFetch(handlers: Record<string, () => { status: number; body: Record<string, unknown> }> = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      const handler = handlers[`${method} ${url}`] ?? (() => ({ status: 200, body: { ok: true } }));
      const { status, body } = handler();
      return { ok: status < 400, status, json: async () => body };
    }),
  );
  return calls;
}

const NO_ACCOUNTS: never[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("OnboardingWizard", () => {
  it("starts at the currency step, showing all three steps with the current one marked", () => {
    installFetch();
    render(<OnboardingWizard initialStep={1} initialCurrency="ILS" accounts={NO_ACCOUNTS} />);
    expect(screen.getByRole("heading", { name: "Set up PFW" })).toBeInTheDocument();
    const steps = within(screen.getByRole("list", { name: "Setup steps" })).getAllByRole("listitem");
    expect(steps.map((step) => step.textContent)).toEqual(["1. Currency", "2. First account", "3. Your transactions"]);
    expect(steps[0]).toHaveAttribute("aria-current", "step");
    expect(screen.getByLabelText("Show totals in")).toHaveValue("ILS");
  });

  it("saves the chosen currency, then moves to adding the first account", async () => {
    const calls = installFetch();
    render(<OnboardingWizard initialStep={1} initialCurrency="ILS" accounts={NO_ACCOUNTS} />);
    fireEvent.change(screen.getByLabelText("Show totals in"), { target: { value: "USD" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("heading", { name: "Add your first account" })).toBeInTheDocument();
    expect(calls).toContainEqual({ url: "/api/user-settings", method: "PATCH", body: { reportingCurrency: "USD" } });
    // The real "Add bank account" form is what is shown.
    expect(screen.getByRole("button", { name: "Add bank account" })).toBeInTheDocument();
  });

  it("stays on the currency step and says so when saving it fails", async () => {
    installFetch({ "PATCH /api/user-settings": () => ({ status: 500, body: {} }) });
    render(<OnboardingWizard initialStep={1} initialCurrency="ILS" accounts={NO_ACCOUNTS} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save your currency");
    expect(screen.getByLabelText("Show totals in")).toBeInTheDocument();
  });

  it("moves to the import step with the new account already selectable", async () => {
    installFetch({
      "POST /api/bank-accounts": () => ({
        status: 201,
        body: { ok: true, account: { id: "acc-1", institutionName: "QNB", nickname: null, accountType: "CHECKING", currency: "TRY", nativeBalance: 100 } },
      }),
    });
    render(<OnboardingWizard initialStep={2} initialCurrency="USD" accounts={NO_ACCOUNTS} />);
    fireEvent.change(screen.getByLabelText("Institution"), { target: { value: "QNB" } });
    fireEvent.change(screen.getByLabelText("Last 4 digits"), { target: { value: "7669" } });
    fireEvent.change(screen.getByLabelText("Current balance"), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: "Add bank account" }));

    expect(await screen.findByRole("heading", { name: "Bring in your transactions" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "QNB · TRY" })).toBeInTheDocument();
  });

  it("resumes at the import step for someone who already added an account", () => {
    installFetch();
    render(
      <OnboardingWizard initialStep={3} initialCurrency="ILS" accounts={[{ id: "acc-1", label: "Leumi · ILS", currency: "ILS" }]} />,
    );
    expect(screen.getByRole("heading", { name: "Bring in your transactions" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Leumi · ILS" })).toBeInTheDocument();
  });

  it("offers to enter by hand when there is no account to import into", () => {
    installFetch();
    render(<OnboardingWizard initialStep={3} initialCurrency="ILS" accounts={NO_ACCOUNTS} />);
    expect(screen.getByText(/Add an account first to import a statement/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enter transactions by hand instead" })).toBeInTheDocument();
  });

  it("records completion and goes to Transactions when the user chooses to enter by hand", async () => {
    const calls = installFetch();
    render(<OnboardingWizard initialStep={3} initialCurrency="ILS" accounts={NO_ACCOUNTS} />);
    fireEvent.click(screen.getByRole("button", { name: "Enter transactions by hand instead" }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/transactions"));
    expect(calls).toContainEqual({ url: "/api/onboarding/complete", method: "POST", body: undefined });
  });

  it("records completion and goes to the dashboard when finished without importing", async () => {
    const calls = installFetch();
    render(<OnboardingWizard initialStep={3} initialCurrency="ILS" accounts={NO_ACCOUNTS} />);
    fireEvent.click(screen.getByRole("button", { name: "Finish without importing" }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/dashboard"));
    expect(calls.filter((call) => call.url === "/api/onboarding/complete")).toHaveLength(1);
  });

  it("lets the user skip from any step", async () => {
    const calls = installFetch();
    render(<OnboardingWizard initialStep={1} initialCurrency="ILS" accounts={NO_ACCOUNTS} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip setup" }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/dashboard"));
    expect(calls).toContainEqual({ url: "/api/onboarding/complete", method: "POST", body: undefined });
  });

  it("does not leave the wizard, and says so, when completion cannot be saved", async () => {
    installFetch({ "POST /api/onboarding/complete": () => ({ status: 500, body: {} }) });
    render(<OnboardingWizard initialStep={1} initialCurrency="ILS" accounts={NO_ACCOUNTS} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip setup" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save your progress");
    expect(pushMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Skip setup" })).toBeEnabled();
  });
});
