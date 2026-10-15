import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { walkSourceFiles } from "./walk-source-files";

const SRC_ROOT = path.resolve(__dirname, "../../src");

/**
 * Split transactions (AGENTS.md §3xxx): a split row's money is in several
 * categories, so a database `groupBy` on `NotableTransaction.categoryId`
 * would put all of it in the row's largest category and no test of the
 * grouping itself would notice. Totals by category read each row's splits
 * (`SPLIT_PARTS_SELECT`) and go through `categoryParts`; this guard keeps
 * the shortcut from coming back.
 */
const GROUP_BY_CATEGORY = /notableTransaction\.groupBy\(\s*\{[\s\S]{0,300}?by:\s*\[[^\]]*["']categoryId["']/;

describe("guard: category totals read splits", () => {
  const files = walkSourceFiles(SRC_ROOT, [".ts", ".tsx"]).filter((file) => !file.includes(`${path.sep}generated${path.sep}`));

  it("scans the source tree", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("matches the shape it guards against", () => {
    expect(GROUP_BY_CATEGORY.test('tx.notableTransaction.groupBy({ by: ["categoryId"], _sum: { amount: true } })')).toBe(true);
    expect(GROUP_BY_CATEGORY.test('tx.notableTransaction.groupBy({ by: ["importBatchId"] })')).toBe(false);
  });

  it("finds no groupBy on NotableTransaction by category", () => {
    const offenders = files.filter((file) => GROUP_BY_CATEGORY.test(readFileSync(file, "utf8"))).map((file) => path.relative(SRC_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
