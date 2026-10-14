import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(path.resolve(__dirname, "../../src/server/db/encrypted-fields.ts"), "utf8");

/** Every model key in the ENCRYPTED_FIELDS object literal. */
function listedModels(): string[] {
  const block = SOURCE.match(/const ENCRYPTED_FIELDS = \{([\s\S]*?)\n\} as const;/);
  if (!block) throw new Error("could not find the ENCRYPTED_FIELDS literal");
  return [...block[1].matchAll(/^ {2}(\w+): \[/gm)].map((match) => match[1]);
}

/** Every model that withEncryptedFields actually installs a query handler for. */
function registeredModels(): string[] {
  const block = SOURCE.match(/query: \{([\s\S]*?)\n {4}\},/);
  if (!block) throw new Error("could not find the withEncryptedFields query block");
  return [...block[1].matchAll(/^ {6}(\w+): \{ \$allOperations: makeAllOperationsHandler\("(\w+)"\) \}/gm)].map((match) => {
    expect(match[1], "the handler must be built for the model it is installed on").toBe(match[2]);
    return match[1];
  });
}

/**
 * ENCRYPTED_FIELDS and the registrations in withEncryptedFields are two lists
 * that must agree, and nothing else enforces it (AGENTS.md §3rrr). A model in
 * the first but not the second looks protected and is not: BankConnection's
 * access token was stored as plaintext for exactly that reason.
 */
describe("guard: every model listed in ENCRYPTED_FIELDS has its handler registered", () => {
  it("finds both lists", () => {
    expect(listedModels().length).toBeGreaterThan(0);
    expect(registeredModels().length).toBeGreaterThan(0);
  });

  it("registers a handler for every listed model, and lists every registered model", () => {
    expect([...registeredModels()].sort()).toEqual([...listedModels()].sort());
  });
});
