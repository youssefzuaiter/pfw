/**
 * The build-output half of Section 5's "grep client bundles for stray
 * secrets" control (`docs/SECURITY-CHECKLIST.md` item 41). Source-level
 * regex guards (`tests/guards/no-public-secrets.test.ts`) can prove no
 * code ever *reads* a secret env var outside `src/server`, but can't
 * prove a secret's actual *value* never ended up client-shipped some
 * other way (a hardcoded copy-paste, a transitive dependency, etc.) —
 * this script checks the real, compiled output instead of reasoning
 * about source.
 *
 * Run after a production build:
 *   npm run build && npm run verify:client-bundle-secrets
 *
 * Reads today's real secret *values* straight from `process.env` (the
 * same ones the build itself used) and searches every file actually
 * shipped to the browser (`.next/static/`, never `.next/server/`, which
 * legitimately contains secrets in server-only closures a browser never
 * fetches) for a literal occurrence of each one. Never prints a found
 * value — only which named secret and which file — so this tool's own
 * output can't become a leak vector in a CI log.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SECRET_ENV_VAR_NAMES } from "../src/server/env";

// Ignores anything shorter than this: a placeholder like "test" or "x"
// would otherwise false-positive-match almost any file in the bundle.
// Every real secret in this app is far longer (the shortest, ENCRYPTION_KEY,
// is a 32-byte value that's ~44 base64 characters).
const MIN_MEANINGFUL_SECRET_LENGTH = 12;

const CLIENT_BUNDLE_DIR = path.resolve(process.cwd(), ".next/static");
const SCANNABLE_EXTENSIONS = new Set([".js", ".mjs", ".css", ".json", ".html", ".txt", ".map"]);

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (SCANNABLE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function main(): void {
  if (!existsSync(CLIENT_BUNDLE_DIR)) {
    console.error(
      `No production build found at ${path.relative(process.cwd(), CLIENT_BUNDLE_DIR)} — run \`npm run build\` first.`,
    );
    process.exitCode = 1;
    return;
  }

  const secretsToCheck = SECRET_ENV_VAR_NAMES.map((name) => ({ name, value: process.env[name] })).filter(
    (entry): entry is { name: (typeof SECRET_ENV_VAR_NAMES)[number]; value: string } =>
      typeof entry.value === "string" && entry.value.length >= MIN_MEANINGFUL_SECRET_LENGTH,
  );

  if (secretsToCheck.length === 0) {
    console.log(
      "No secret env vars (of meaningful length) are set in this environment — nothing to check the client bundle against.",
    );
    return;
  }

  const files = walk(CLIENT_BUNDLE_DIR);
  const violations: { name: string; file: string }[] = [];

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const { name, value } of secretsToCheck) {
      if (content.includes(value)) {
        violations.push({ name, file: path.relative(process.cwd(), file) });
      }
    }
  }

  if (violations.length > 0) {
    console.error(`Found ${violations.length} secret leak(s) into the client-shipped bundle:`);
    for (const violation of violations) {
      console.error(`  - ${violation.name} appears in ${violation.file}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Checked ${files.length} client bundle file(s) for ${secretsToCheck.length} secret value(s) currently set in the environment — none found.`,
  );
}

main();
