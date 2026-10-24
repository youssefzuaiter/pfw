import { describe, expect, it } from "vitest";
import { checkBalance, TWIN_DAY_WINDOW, type MovementRow } from "./balance-check";

let n = 0;
const row = (day: string, deltaNative: number, label = "x"): MovementRow => ({ id: `r${++n}`, day, label, deltaNative });

describe("checkBalance", () => {
  it("matches when typed balance plus the movement is the bank's figure", () => {
    const result = checkBalance({ typedNative: 100_000, rows: [row("2026-10-02", -20_000), row("2026-10-03", 5_000)], bankNative: 85_000 });
    expect(result).toMatchObject({ expectedNative: 85_000, gapNative: 0, status: "matches", causes: [] });
  });

  it("says which way the gap goes", () => {
    expect(checkBalance({ typedNative: 100_000, rows: [], bankNative: 90_000 })).toMatchObject({ gapNative: -10_000, status: "bank-lower" });
    expect(checkBalance({ typedNative: 100_000, rows: [], bankNative: 130_000 })).toMatchObject({ gapNative: 30_000, status: "bank-higher" });
  });

  it("points at a duplicate: a row that would close the gap and has a twin nearby", () => {
    const a = row("2026-10-05", -15_000, "Cafe");
    const b = row("2026-10-06", -15_000, "Cafe");
    const other = row("2026-10-07", -1_000);
    // The app counted the cafe twice; the bank once.
    const result = checkBalance({ typedNative: 100_000, rows: [a, b, other], bankNative: 100_000 - 15_000 - 1_000 });
    expect(result.gapNative).toBe(15_000);
    expect(result.causes[0]).toMatchObject({ kind: "duplicate" });
    const first = result.causes[0] as { rowId: string; twinId: string };
    expect(new Set([first.rowId, first.twinId])).toEqual(new Set([a.id, b.id]));
    // The same pair is not listed twice.
    expect(result.causes.filter((c) => c.kind === "duplicate")).toHaveLength(1);
    expect(result.causes.at(-1)).toEqual({ kind: "missing-or-start" });
  });

  it("does not call two equal rows far apart twins, and only just inside the window is a twin", () => {
    const first = row("2026-10-01", -15_000);
    const far = row("2026-10-20", -15_000);
    const apart = checkBalance({ typedNative: 100_000, rows: [first, far], bankNative: 100_000 - 15_000 });
    expect(apart.causes.map((c) => c.kind)).toEqual(["extra-row", "extra-row", "missing-or-start"]);

    const near = row(`2026-10-0${1 + TWIN_DAY_WINDOW}`, -15_000);
    const close = checkBalance({ typedNative: 100_000, rows: [first, near], bankNative: 100_000 - 15_000 });
    expect(close.causes[0]).toMatchObject({ kind: "duplicate" });
  });

  it("points at a row the bank does not have when it has no twin", () => {
    const only = row("2026-10-05", -15_000);
    const result = checkBalance({ typedNative: 100_000, rows: [only, row("2026-10-06", -2_000)], bankNative: 100_000 - 2_000 });
    expect(result.causes[0]).toEqual({ kind: "extra-row", rowId: only.id });
  });

  it("points at a row with the wrong sign: out by twice its size", () => {
    const wrong = row("2026-10-05", 4_000, "Refund");
    // The bank has it as money out, so it is 8,000 lower than the app says.
    const result = checkBalance({ typedNative: 100_000, rows: [wrong], bankNative: 100_000 - 4_000 });
    expect(result.gapNative).toBe(-8_000);
    expect(result.causes).toContainEqual({ kind: "wrong-sign", rowId: wrong.id });
  });

  it("falls back to a missing transaction or a wrong starting balance, with nothing specific to point at", () => {
    const result = checkBalance({ typedNative: 100_000, rows: [row("2026-10-05", -2_000)], bankNative: 90_000 });
    expect(result.causes).toEqual([{ kind: "missing-or-start" }]);
  });

  it("keeps at most a few causes", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`2026-10-${String(10 + i).padStart(2, "0")}`, -5_000));
    const result = checkBalance({ typedNative: 100_000, rows, bankNative: 100_000 - 45_000 });
    expect(result.causes.length).toBeLessThanOrEqual(4);
  });

  it("handles a card, where the balance is money owed", () => {
    // Owed 50,000 typed; a charge (+8,000 owed) and a payment (-20,000 owed).
    const result = checkBalance({ typedNative: 50_000, rows: [row("2026-10-02", 8_000), row("2026-10-03", -20_000)], bankNative: 38_000 });
    expect(result).toMatchObject({ expectedNative: 38_000, status: "matches" });
  });
});
