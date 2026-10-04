import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildChain, initialBuildSpecs, reportPayload } from "../../../tests/integration/core-sync-fixtures";
import type { ReportPayload } from "../paper-trader/core-sync-schema";

const withUserScope = vi.fn();
vi.mock("../db/with-user-scope", () => ({ withUserScope: (...args: unknown[]) => withUserScope(...args) }));

import { CoreMirrorUnavailableError, getCoreMirror, ingestCoreJournal, isMissingSchemaError, recordCoreReport } from "./core-mirror";

/**
 * What the mirror does when its tables are not there yet — a deploy whose
 * migration has not been applied (AGENTS.md §3eee is the incident that
 * made this a requirement). The error code is the one the real pg driver
 * adapter produces (P2021, checked by hand against a renamed table); here
 * the database is replaced so the behaviour is pinned without needing a
 * database to break.
 */
const missingTable = Object.assign(new Error("The table `public.CoreJournalEntry` does not exist"), { code: "P2021" });
const missingColumn = Object.assign(new Error("The column does not exist"), { code: "P2022" });

beforeEach(() => {
  withUserScope.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("isMissingSchemaError", () => {
  it("recognises a missing table or column and nothing else", () => {
    expect(isMissingSchemaError(missingTable)).toBe(true);
    expect(isMissingSchemaError(missingColumn)).toBe(true);
    expect(isMissingSchemaError(Object.assign(new Error("dup"), { code: "P2002" }))).toBe(false);
    expect(isMissingSchemaError(new Error("plain"))).toBe(false);
    expect(isMissingSchemaError(null)).toBe(false);
    expect(isMissingSchemaError("P2021")).toBe(false);
  });
});

describe("when the core mirror tables are missing", () => {
  const chain = buildChain(initialBuildSpecs());

  it("reads as unavailable, so the page can say so instead of crashing", async () => {
    withUserScope.mockRejectedValue(missingTable);
    expect(await getCoreMirror("user-1")).toEqual({ available: false });
  });

  it("refuses a journal write with a typed error the webhook can answer 503 to", async () => {
    withUserScope.mockRejectedValue(missingTable);
    const error = await ingestCoreJournal("user-1", { chainId: chain[0].hash, entries: chain }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoreMirrorUnavailableError);
    expect((error as Error).cause).toBe(missingTable);
  });

  it("refuses a report write the same way", async () => {
    withUserScope.mockRejectedValue(missingColumn);
    await expect(recordCoreReport("user-1", reportPayload() as unknown as ReportPayload)).rejects.toBeInstanceOf(CoreMirrorUnavailableError);
  });

  it("does not hide any other failure behind 'unavailable'", async () => {
    const outage = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    withUserScope.mockRejectedValue(outage);
    await expect(getCoreMirror("user-1")).rejects.toBe(outage);
    await expect(ingestCoreJournal("user-1", { chainId: chain[0].hash, entries: chain })).rejects.toBe(outage);
    await expect(recordCoreReport("user-1", reportPayload() as unknown as ReportPayload)).rejects.toBe(outage);
  });
});
