import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Account deletion (AGENTS.md §3ttt) deletes one User row and relies on the
 * database to remove everything that belongs to it. That only works while
 * every relation to User cascades. A table added later with a plain
 * `userId` column, or a relation left at the default (RESTRICT), would either
 * block deletion or leave the user's rows behind with nothing pointing at
 * them. This guard fails first.
 *
 * Rules, read from prisma/schema.prisma:
 * - every relation to User is ON DELETE CASCADE, except an optional one
 *   (`User?`), which may be SET NULL: a row that merely mentions a user
 *   (GroupInvite.acceptedBy) and belongs to someone else;
 * - every `userId` field belongs to a relation to User.
 */
const SCHEMA = readFileSync(path.resolve(__dirname, "../../prisma/schema.prisma"), "utf8");

type ModelBlock = { name: string; lines: string[] };

function modelBlocks(schema: string): ModelBlock[] {
  const blocks: ModelBlock[] = [];
  const pattern = /^model (\w+) \{\n([\s\S]*?)^\}/gm;
  for (const match of schema.matchAll(pattern)) {
    const lines = match[2]
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, "").trim())
      .filter(Boolean);
    blocks.push({ name: match[1], lines });
  }
  return blocks;
}

const MODELS = modelBlocks(SCHEMA);

function relationsToUser(model: ModelBlock) {
  return model.lines
    .filter((line) => /^\w+\s+User\??\s/.test(line) && line.includes("fields:"))
    .map((line) => ({
      line,
      optional: /^\w+\s+User\?\s/.test(line),
      fields: /fields:\s*\[([^\]]*)\]/.exec(line)?.[1].split(",").map((f) => f.trim()) ?? [],
      onDelete: /onDelete:\s*(\w+)/.exec(line)?.[1] ?? null,
    }));
}

describe("every relation to User cascades on account deletion", () => {
  it("parses the schema (sanity check)", () => {
    expect(MODELS.length).toBeGreaterThan(40);
    expect(relationsToUser(MODELS.find((m) => m.name === "NotableTransaction")!)).toHaveLength(1);
  });

  it("every relation to User is ON DELETE CASCADE (an optional one may be SET NULL)", () => {
    const offenders: string[] = [];
    for (const model of MODELS) {
      for (const relation of relationsToUser(model)) {
        const allowed = relation.onDelete === "Cascade" || (relation.optional && relation.onDelete === "SetNull");
        if (!allowed) offenders.push(`${model.name}: ${relation.line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every userId field belongs to a relation to User", () => {
    const offenders: string[] = [];
    for (const model of MODELS) {
      if (model.name === "User") continue;
      const hasUserIdField = model.lines.some((line) => /^userId\s+String/.test(line));
      if (!hasUserIdField) continue;
      const covered = relationsToUser(model).some((relation) => relation.fields.includes("userId"));
      if (!covered) offenders.push(model.name);
    }
    expect(offenders).toEqual([]);
  });

  it("catches the shapes it exists for", () => {
    const broken = modelBlocks(`model Thing {
  id     String @id
  userId String
  user   User   @relation(fields: [userId], references: [id])
}
model Loose {
  id     String @id
  userId String
}
`);
    const thing = relationsToUser(broken[0]);
    expect(thing[0].onDelete).toBeNull();
    expect(relationsToUser(broken[1])).toHaveLength(0);
  });
});
