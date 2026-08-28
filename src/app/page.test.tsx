import { describe, expect, it, vi } from "vitest";

const { redirectMock } = vi.hoisted(() => ({ redirectMock: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

const { default: Home } = await import("./page");

describe("Home", () => {
  it("redirects to /dashboard — this app has no separate landing page", () => {
    Home();
    expect(redirectMock).toHaveBeenCalledWith("/dashboard");
  });
});
