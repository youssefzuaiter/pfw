import { describe, expect, it } from "vitest";
import { initialOnboardingStep, needsOnboarding } from "./onboarding";

const DONE = new Date("2026-10-01T00:00:00Z");

describe("needsOnboarding", () => {
  it("sends a brand-new user, with nothing in the app, to the wizard", () => {
    expect(needsOnboarding({ completedAt: null, accountCount: 0, transactionCount: 0 })).toBe(true);
  });

  it("keeps sending someone who added an account but has no transactions yet", () => {
    expect(needsOnboarding({ completedAt: null, accountCount: 1, transactionCount: 0 })).toBe(true);
  });

  it("never sends someone who finished or skipped it, however empty the app is", () => {
    expect(needsOnboarding({ completedAt: DONE, accountCount: 0, transactionCount: 0 })).toBe(false);
    expect(needsOnboarding({ completedAt: DONE, accountCount: 1, transactionCount: 0 })).toBe(false);
  });

  it("never sends someone who already uses the app, even if they never saw the wizard", () => {
    expect(needsOnboarding({ completedAt: null, accountCount: 2, transactionCount: 340 })).toBe(false);
  });

  it("sends someone with transactions but no account to add one first", () => {
    expect(needsOnboarding({ completedAt: null, accountCount: 0, transactionCount: 5 })).toBe(true);
  });
});

describe("initialOnboardingStep", () => {
  it("starts at the currency step with no account", () => {
    expect(initialOnboardingStep({ accountCount: 0 })).toBe(1);
  });

  it("resumes at the import step once an account exists", () => {
    expect(initialOnboardingStep({ accountCount: 1 })).toBe(3);
  });
});
