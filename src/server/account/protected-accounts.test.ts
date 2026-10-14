import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../paper-trader/resolve-paper-trading-user", () => ({ resolvePaperTradingUser: vi.fn() }));

import { whyAccountCannotBeDeleted } from "./protected-accounts";
import { resolvePaperTradingUser } from "../paper-trader/resolve-paper-trading-user";

/** Which accounts the deployment depends on and so refuses to delete (AGENTS.md §3ttt). */
describe("whyAccountCannotBeDeleted", () => {
  const original = process.env.NEXT_PUBLIC_DEMO_MODE;

  beforeEach(() => {
    vi.mocked(resolvePaperTradingUser).mockResolvedValue({ status: "unconfigured" });
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_DEMO_MODE;
    else process.env.NEXT_PUBLIC_DEMO_MODE = original;
  });

  it("allows an ordinary account", async () => {
    expect(await whyAccountCannotBeDeleted({ id: "u1", email: "owner@example.com" })).toBeNull();
  });

  it("protects the demo account only while demo mode is on", async () => {
    const demo = { id: "demo", email: "Demo@PFW.local" };
    expect(await whyAccountCannotBeDeleted(demo)).toBeNull();
    process.env.NEXT_PUBLIC_DEMO_MODE = "true";
    expect(await whyAccountCannotBeDeleted(demo)).toMatch(/demo account/);
  });

  it("protects the account the paper trader books into, and no other", async () => {
    vi.mocked(resolvePaperTradingUser).mockResolvedValue({ status: "ok", userId: "trader" });
    expect(await whyAccountCannotBeDeleted({ id: "trader", email: "t@example.com" })).toMatch(/PAPER_TRADING_USER_EMAIL/);
    expect(await whyAccountCannotBeDeleted({ id: "someone", email: "s@example.com" })).toBeNull();
  });
});
