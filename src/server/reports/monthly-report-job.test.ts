import { describe, expect, it, vi } from "vitest";
import { previousMonthKey, sendMonthlyReports } from "./monthly-report-job";
import type { MonthlyReportData } from "./monthly-report";

const NOW = new Date("2026-10-01T00:05:00Z");

const DATA: MonthlyReportData = {
  monthKey: "2026-09",
  incomeAgorot: 100n,
  expenseAgorot: 50n,
  incomeShown: 100,
  expenseShown: 50,
  topCategories: [],
  netWorth: null,
  core: null,
};

function makeDeps() {
  return {
    listCandidates: vi.fn().mockResolvedValue([
      { userId: "u1", email: "one@example.com" },
      { userId: "u2", email: "two@example.com" },
    ]),
    claim: vi.fn().mockResolvedValue({ claimed: true, previous: "2026-08" }),
    release: vi.fn().mockResolvedValue(undefined),
    gather: vi.fn().mockResolvedValue(DATA),
    send: vi.fn().mockResolvedValue(undefined),
    appUrl: () => "https://pfw.example",
  };
}

type TestDeps = ReturnType<typeof makeDeps>;

function deps(overrides: Partial<TestDeps> = {}): TestDeps {
  return { ...makeDeps(), ...overrides };
}

describe("previousMonthKey", () => {
  it("is the month before, across a year boundary too", () => {
    expect(previousMonthKey(new Date("2026-10-01T00:00:00Z"))).toBe("2026-09");
    expect(previousMonthKey(new Date("2026-10-31T23:59:59Z"))).toBe("2026-09");
    expect(previousMonthKey(new Date("2027-01-01T00:00:00Z"))).toBe("2026-12");
  });
});

describe("sendMonthlyReports", () => {
  it("sends last month's report to every opted-in user who has not had it", async () => {
    const d = deps();
    const result = await sendMonthlyReports(NOW, d);

    expect(result).toEqual({ ok: true, monthKey: "2026-09", sent: 2, failed: 0 });
    expect(d.listCandidates).toHaveBeenCalledWith("2026-09");
    expect(d.gather).toHaveBeenCalledWith("u1", "2026-09");
    expect(d.send.mock.calls.map(([input]) => [input.to, input.subject])).toEqual([
      ["one@example.com", "Your PFW summary for September 2026"],
      ["two@example.com", "Your PFW summary for September 2026"],
    ]);
    expect(d.release).not.toHaveBeenCalled();
  });

  it("skips a user whose claim fails, so a month is never sent twice", async () => {
    const d = deps({
      claim: vi.fn().mockResolvedValueOnce({ claimed: false }).mockResolvedValueOnce({ claimed: true, previous: null }),
    });
    const result = await sendMonthlyReports(NOW, d);

    expect(result).toEqual({ ok: true, monthKey: "2026-09", sent: 1, failed: 0 });
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(d.send.mock.calls[0][0].to).toBe("two@example.com");
  });

  it("puts the claim back when the send fails, so tomorrow retries", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps({ send: vi.fn().mockRejectedValueOnce(new Error("Resend 503")).mockResolvedValueOnce(undefined) });
    const result = await sendMonthlyReports(NOW, d);

    expect(result).toEqual({ ok: true, monthKey: "2026-09", sent: 1, failed: 1 });
    expect(d.release).toHaveBeenCalledTimes(1);
    expect(d.release).toHaveBeenCalledWith("u1", "2026-09", "2026-08");
  });

  it("reports a failure, without throwing, when the opted-in users cannot be listed", async () => {
    const d = deps({ listCandidates: vi.fn().mockRejectedValue(new Error("database unreachable")) });
    expect(await sendMonthlyReports(NOW, d)).toEqual({ ok: false, error: "database unreachable" });
    expect(d.send).not.toHaveBeenCalled();
  });
});
