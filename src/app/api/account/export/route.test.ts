import { NextRequest } from "next/server";
import { strFromU8, unzipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The export route's wiring (AGENTS.md §3uuu): the guard, the format choice,
 * download headers that keep the file out of every cache, and the audit
 * entry. Gathering is mocked; it runs for real, two users and all, in
 * tests/integration/data-export.test.ts.
 */
vi.mock("../../../../server/api/guard-mutation", () => ({ guardMutation: vi.fn() }));
vi.mock("../../../../server/dal/audit-log", () => ({ recordAuditLog: vi.fn() }));
vi.mock("../../../../server/dal/data-export", () => ({ gatherUserExport: vi.fn() }));

import { POST } from "./route";
import { guardMutation } from "../../../../server/api/guard-mutation";
import { recordAuditLog } from "../../../../server/dal/audit-log";
import { gatherUserExport } from "../../../../server/dal/data-export";
import { EXPORT_TABLES } from "../../../../lib/data-export/format";

const DATA = {
  account: { id: "user-1", email: "owner@example.com" },
  tables: Object.fromEntries(EXPORT_TABLES.map((name) => [name, name === "transactions" ? [{ id: "t1", amount: "-12550" }] : []])),
};

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/account/export", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
}

describe("POST /api/account/export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(guardMutation).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(gatherUserExport).mockResolvedValue(DATA as never);
  });

  it("downloads JSON, uncached, and records the export", async () => {
    const response = await POST(request({ format: "json" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="pfw-export-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const document = JSON.parse(await response.text());
    expect(document).toMatchObject({ format: "pfw-export", version: 1, account: DATA.account });
    expect(document.tables.transactions).toEqual([{ id: "t1", amount: "-12550" }]);
    expect(gatherUserExport).toHaveBeenCalledWith("user-1");
    expect(recordAuditLog).toHaveBeenCalledWith("user-1", expect.objectContaining({ entityType: "DataExport", afterData: { format: "json" } }));
  });

  it("downloads a ZIP of CSVs", async () => {
    const response = await POST(request({ format: "csv" }));
    expect(response.headers.get("content-type")).toBe("application/zip");
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(["README.txt", "account.csv", "transactions.csv"]);
    expect(strFromU8(files["transactions.csv"])).toBe("id,amount\r\nt1,-12550\r\n");
  });

  it("returns the guard's response untouched", async () => {
    vi.mocked(guardMutation).mockResolvedValue({ response: new Response(null, { status: 403 }) } as never);
    expect((await POST(request({ format: "json" }))).status).toBe(403);
    expect(gatherUserExport).not.toHaveBeenCalled();
  });

  it("refuses an unknown format or a body that is not JSON", async () => {
    for (const body of [{ format: "xml" }, {}, "nope"]) expect((await POST(request(body))).status).toBe(400);
    expect(gatherUserExport).not.toHaveBeenCalled();
  });

  it("answers 404 for a vanished account and 500 without details on failure", async () => {
    vi.mocked(gatherUserExport).mockResolvedValueOnce(null);
    expect((await POST(request({ format: "json" }))).status).toBe(404);
    vi.mocked(gatherUserExport).mockRejectedValueOnce(new Error("secret detail"));
    const failed = await POST(request({ format: "json" }));
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("secret detail");
    expect(recordAuditLog).not.toHaveBeenCalled();
  });
});
