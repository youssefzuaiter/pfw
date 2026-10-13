import { describe, expect, it, vi } from "vitest";
import { recordDailyNetWorthSnapshots } from "./snapshot-job";

const NOW = new Date("2026-10-14T00:00:00Z");

describe("recordDailyNetWorthSnapshots", () => {
  it("records a snapshot for every user, with the same timestamp", async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const result = await recordDailyNetWorthSnapshots(NOW, { listUserIds: async () => ["a", "b", "c"], record });

    expect(result).toEqual({ ok: true, recorded: 3, failed: 0 });
    expect(record.mock.calls).toEqual([
      ["a", NOW],
      ["b", NOW],
      ["c", NOW],
    ]);
  });

  it("keeps going when one user fails, and counts the failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const record = vi.fn(async (userId: string) => {
      if (userId === "b") throw new Error("wallet RPC timed out");
    });
    const result = await recordDailyNetWorthSnapshots(NOW, { listUserIds: async () => ["a", "b", "c"], record });

    expect(result).toEqual({ ok: true, recorded: 2, failed: 1 });
    expect(record).toHaveBeenCalledTimes(3);
  });

  it("reports a failure, without throwing, when the user list cannot be read", async () => {
    const record = vi.fn();
    const result = await recordDailyNetWorthSnapshots(NOW, {
      listUserIds: async () => {
        throw new Error("database unreachable");
      },
      record,
    });

    expect(result).toEqual({ ok: false, error: "database unreachable" });
    expect(record).not.toHaveBeenCalled();
  });

  it("is a clean no-op with no users", async () => {
    const result = await recordDailyNetWorthSnapshots(NOW, { listUserIds: async () => [], record: vi.fn() });
    expect(result).toEqual({ ok: true, recorded: 0, failed: 0 });
  });
});
