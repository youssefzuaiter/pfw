import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock("next-auth/react", () => ({ signOut: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../../lib/rag/local-vector-store", () => ({ clearLocalVectorStore: vi.fn().mockResolvedValue(undefined) }));

const { DeleteAccountPanel } = await import("./delete-account-panel");
const { signOut } = await import("next-auth/react");
const { clearLocalVectorStore } = await import("../../../lib/rag/local-vector-store");

/** Settings → Delete account (AGENTS.md §3ttt): what it asks for, what it warns about, and what it clears. */
describe("DeleteAccountPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem("pfw-currency-display-mode", "native");
  });

  function open(props: Partial<Parameters<typeof DeleteAccountPanel>[0]> = {}) {
    render(<DeleteAccountPanel totpEnabled={false} ownedHouseholds={[]} hasEmergencyVault={false} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete account…" }));
  }

  function fill(fields: { password?: string; totp?: string; confirm?: string }) {
    if (fields.password !== undefined) fireEvent.change(screen.getByLabelText("Current password"), { target: { value: fields.password } });
    if (fields.totp !== undefined) fireEvent.change(screen.getByLabelText("Code from your authenticator app"), { target: { value: fields.totp } });
    if (fields.confirm !== undefined) fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), { target: { value: fields.confirm } });
  }

  const submit = () => screen.getByRole("button", { name: "Delete my account" });

  it("stays collapsed until asked for", () => {
    render(<DeleteAccountPanel totpEnabled={false} ownedHouseholds={[]} hasEmergencyVault={false} />);
    expect(screen.queryByLabelText("Current password")).toBeNull();
  });

  it("names the household and the Emergency Vault it will remove, and the backup window", () => {
    open({ ownedHouseholds: ["The Household"], hasEmergencyVault: true });
    expect(screen.getByText(/the household “The Household” for all its members/)).toBeTruthy();
    expect(screen.getByText(/Emergency Vault/)).toBeTruthy();
    expect(screen.getByText(/nightly backups for up to 30 days/)).toBeTruthy();
  });

  it("enables the button only with a password and the exact word DELETE", () => {
    open();
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
    fill({ password: "secret", confirm: "delete" });
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
    fill({ confirm: "DELETE" });
    expect((submit() as HTMLButtonElement).disabled).toBe(false);
  });

  it("asks for the authenticator code when two-factor sign-in is on", () => {
    open({ totpEnabled: true });
    fill({ password: "secret", confirm: "DELETE" });
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
    fill({ totp: "123456" });
    expect((submit() as HTMLButtonElement).disabled).toBe(false);
  });

  it("on success clears this browser's copies, signs out and says so on the login page", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ deleted: true }) });
    vi.stubGlobal("fetch", fetchMock);
    open({ totpEnabled: true });
    fill({ password: "secret", totp: " 123456 ", confirm: "DELETE" });
    fireEvent.click(submit());

    await waitFor(() => expect(push).toHaveBeenCalledWith("/login?deleted=1"));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ password: "secret", totpCode: "123456", confirm: "DELETE" });
    expect(clearLocalVectorStore).toHaveBeenCalled();
    expect(window.localStorage.getItem("pfw-currency-display-mode")).toBeNull();
    expect(signOut).toHaveBeenCalledWith({ redirect: false });
  });

  it("shows the server's reason and keeps the session when the deletion is refused", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "Incorrect password" }) }));
    open();
    fill({ password: "wrong", confirm: "DELETE" });
    fireEvent.click(submit());

    expect((await screen.findByRole("alert")).textContent).toBe("Incorrect password");
    expect(signOut).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("pfw-currency-display-mode")).toBe("native");
  });
});
