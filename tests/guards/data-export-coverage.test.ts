import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXCLUDED_FROM_EXPORT, EXPORT_TABLE_MODELS, EXPORT_TABLES } from "../../src/lib/data-export/format";

/**
 * The data export (AGENTS.md §3uuu) must stay complete as the schema grows:
 * every model with a userId column is either exported or excluded with a
 * stated reason. A new table that is neither fails here, before a user gets
 * an export missing their data.
 *
 * It also keeps the export's reads flat: no `include`, because a nested
 * relation skips field decryption and is where another user's row could
 * come in through a join.
 */
const ROOT = path.resolve(__dirname, "../..");
const SCHEMA = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");

function modelsWithUserId(schema: string): string[] {
  const names: string[] = [];
  for (const match of schema.matchAll(/^model (\w+) \{\n([\s\S]*?)^\}/gm)) {
    if (/^\s+userId\s+String/m.test(match[2])) names.push(match[1]);
  }
  return names;
}

describe("data export coverage", () => {
  it("exports or explicitly excludes every model with a userId column", () => {
    const exported = new Set(Object.values(EXPORT_TABLE_MODELS));
    const excluded = new Set(Object.keys(EXCLUDED_FROM_EXPORT));
    const models = modelsWithUserId(SCHEMA);

    expect(models.length).toBeGreaterThanOrEqual(38); // sanity: the parser found the schema's user tables
    expect(models.filter((model) => !exported.has(model) && !excluded.has(model))).toEqual([]);
    expect([...exported].filter((model) => excluded.has(model))).toEqual([]);
    expect([...excluded].filter((model) => !models.includes(model))).toEqual([]);
  });

  it("maps every exported table to a model, once", () => {
    expect(Object.keys(EXPORT_TABLE_MODELS).sort()).toEqual([...EXPORT_TABLES].sort());
    expect(new Set(Object.values(EXPORT_TABLE_MODELS)).size).toBe(EXPORT_TABLES.length);
  });

  it("reads every table flat, with no relation included", () => {
    const source = readFileSync(path.join(ROOT, "src/server/dal/data-export.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(source).not.toMatch(/\binclude\s*:/);
    expect(source).not.toMatch(/\$queryRaw/);
  });
});
