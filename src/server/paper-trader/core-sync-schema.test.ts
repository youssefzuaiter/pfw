import { describe, expect, it } from "vitest";
import {
  buildChain,
  initialBuildSpecs,
  journalPayload,
  reportPayload,
} from "../../../tests/integration/core-sync-fixtures";
import { CoreSyncPayloadSchema, MAX_JOURNAL_BATCH, MAX_RAW_LINE_LENGTH } from "./core-sync-schema";

const chain = buildChain(initialBuildSpecs());
const journal = () => journalPayload(chain[0].hash, chain);

const accepts = (payload: unknown) => expect(CoreSyncPayloadSchema.safeParse(payload).success).toBe(true);
const rejects = (payload: unknown) => expect(CoreSyncPayloadSchema.safeParse(payload).success).toBe(false);

describe("CoreSyncPayloadSchema: journal batches", () => {
  it("accepts a whole journal and a sub-batch of it", () => {
    accepts(journal());
    accepts(journalPayload(chain[0].hash, chain.slice(2, 4)));
  });

  it("tells the two kinds apart by `kind`", () => {
    const parsed = CoreSyncPayloadSchema.parse(journal());
    expect(parsed.kind).toBe("journal");
    expect(CoreSyncPayloadSchema.parse(reportPayload()).kind).toBe("report");
  });

  it.each([
    ["a schema version it does not know", { ...journal(), schema_version: 2 }],
    ["a kind it does not know", { ...journal(), kind: "heartbeat" }],
    ["no entries", { ...journal(), entries: [] }],
    ["a chain id that is not a hash", { ...journal(), chain_id: "abc" }],
    ["an upper-case chain id", { ...journal(), chain_id: chain[0].hash.toUpperCase() }],
    ["no idempotency key", { ...journal(), idempotency_key: "" }],
    ["an over-long idempotency key", { ...journal(), idempotency_key: "k".repeat(129) }],
  ])("rejects %s", (_label, payload) => {
    rejects(payload);
  });

  it(`rejects more than ${MAX_JOURNAL_BATCH} entries in one batch`, () => {
    const entry = journal().entries[0];
    rejects({ ...journal(), entries: Array.from({ length: MAX_JOURNAL_BATCH + 1 }, (_, i) => ({ ...entry, index: i })) });
  });

  it.each([
    ["a negative index", { index: -1 }],
    ["a fractional index", { index: 1.5 }],
    ["an index that is a string", { index: "1" }],
    ["a hash that is not a hash", { hash: "nope" }],
    ["a prev that is neither empty nor a hash", { prev: "abc" }],
    ["an empty line", { raw: "" }],
    ["a line over the size limit", { raw: "x".repeat(MAX_RAW_LINE_LENGTH + 1) }],
  ])("rejects an entry with %s", (_label, change) => {
    const payload = journal();
    payload.entries[1] = { ...payload.entries[1], ...change } as never;
    rejects(payload);
  });

  it("accepts an empty prev (the first entry of a journal) and ignores fields it does not know, so a newer trader can add some", () => {
    accepts({ ...journal(), future_field: { anything: true } });
    expect(chain[0].prev).toBe("");
  });
});

describe("CoreSyncPayloadSchema: reports", () => {
  it("accepts a report with an account, and one without", () => {
    accepts(reportPayload());
    accepts(reportPayload({ account: null }));
  });

  it("accepts a router that is halted, disabled, and waiting on the owner", () => {
    accepts(
      reportPayload({
        status: {
          trading_enabled: false,
          disabled_reason: "wrong_account: connected to 'PA1', the policy names 'PA2'",
          halted: true,
          halt_reason: "Emergency halt",
          plan: { id: "a1b2c3d4e5f60718", kind: "initial", status: "awaiting_approval", execute_on: "2026-10-05" },
          journal: { ok: false, entries: 12, reason: "an entry was altered or removed: the hash chain is broken" },
          tick_age_seconds: null,
          tick_failures: 4,
          attention: ["trading is disabled: wrong_account", "the kill switch is on: Emergency halt"],
        },
      }),
    );
  });

  it.each([
    ["a cents figure that is not an integer", { account: { equity_usd_cents: 1000.5 } }],
    ["a cents figure that is a string", { account: { cash_usd_cents: "100" } }],
    ["a cents figure beyond the safe integers", { account: { equity_usd_cents: Number.MAX_SAFE_INTEGER + 2 } }],
    ["a quantity with more than nine decimals", { account: { positions: [{ symbol: "VTI", qty: "1.0123456789", market_value_usd_cents: 1, avg_entry_price_usd_cents: 1, current_price_usd_cents: 1 }] } }],
    ["a quantity in scientific notation", { account: { positions: [{ symbol: "VTI", qty: "1e3", market_value_usd_cents: 1, avg_entry_price_usd_cents: 1, current_price_usd_cents: 1 }] } }],
    ["a target weight that is not a decimal", { account: { targets: { VTI: "nineteen percent" } } }],
    ["a position with no symbol", { account: { positions: [{ symbol: "", qty: "1", market_value_usd_cents: 1, avg_entry_price_usd_cents: 1, current_price_usd_cents: 1 }] } }],
    ["more than a hundred positions", { account: { positions: Array.from({ length: 101 }, (_, i) => ({ symbol: `S${i}`, qty: "1", market_value_usd_cents: 1, avg_entry_price_usd_cents: 1, current_price_usd_cents: 1 })) } }],
    ["a snapshot time that is not a time", { account: { taken_at: "later" } }],
    ["more than twenty attention items", { status: { attention: Array.from({ length: 21 }, (_, i) => `item ${i}`) } }],
    ["an attention item that is far too long", { status: { attention: ["x".repeat(501)] } }],
    ["a plan execution date that is not a date", { status: { plan: { id: "a", kind: "initial", status: "approved", execute_on: "tomorrow" } } }],
    ["a policy hash that is not a hash", { status: { policy_sha256: "abc" } }],
    ["a negative tick age", { status: { tick_age_seconds: -1 } }],
  ])("rejects %s", (_label, over) => {
    rejects(reportPayload(over as never));
  });

  it("rejects a report time that is not a time", () => {
    rejects({ ...reportPayload(), reported_at: "whenever" });
  });

  it("allows a missing market value or price (the broker did not supply one)", () => {
    accepts(
      reportPayload({
        account: {
          positions: [{ symbol: "VTI", qty: "12.5", market_value_usd_cents: null, avg_entry_price_usd_cents: null, current_price_usd_cents: null }],
        },
      }),
    );
  });
});
