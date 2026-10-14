/**
 * Deletes again, after a backup restore, the accounts deleted since that
 * backup was taken (AGENTS.md §3ttt, docs/BACKUP-RESTORE.md "Restore").
 *
 * A restored backup brings back every account deleted after the night it
 * was taken. AccountDeletionRecord holds those accounts' ids; it is restored
 * too, but only up to the same night, so the list has to come from a NEWER
 * copy of it: the live database before it is replaced, or a newer backup.
 *
 *   1. Export the ids from the newer database, as its owner:
 *        psql '<newer db>' -At -c 'SELECT coalesce(json_agg("deletedUserId"), $$[]$$) FROM "AccountDeletionRecord"' > deleted-accounts.json
 *   2. Run this against the RESTORED database:
 *        DATABASE_URL='<restored db, owner role>' npm run account:reapply-deletions -- deleted-accounts.json
 *
 * Each id goes through the same deleteAccount the app uses: one transaction
 * per account, refused (and reported) if another user's rows point at it.
 * An id with no account in the restored database is skipped. Safe to run
 * twice.
 *
 * Needs `--conditions=react-server` like every script that reaches into
 * src/server/** (see AGENTS.md's deviations list).
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { deleteAccount } from "../src/server/account/delete-account";

function readIds(path: string): string[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${path} must hold a JSON array of user ids`);
  const ids = parsed.map((entry) => (typeof entry === "object" && entry !== null ? (entry as { deletedUserId?: unknown }).deletedUserId : entry));
  if (!ids.every((id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id))) {
    throw new Error(`${path} holds something that is not a user id`);
  }
  return [...new Set(ids)];
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: npm run account:reapply-deletions -- <deleted-accounts.json>");
    process.exitCode = 1;
    return;
  }

  const ids = readIds(file);
  let deleted = 0;
  let absent = 0;
  let refused = 0;
  for (const id of ids) {
    const result = await deleteAccount(id);
    if (result.ok) deleted++;
    else if (result.error === "not_found") absent++;
    else {
      refused++;
      console.error(`Account ${id} NOT deleted: other users' rows reference it (${result.references.join(", ")}).`);
    }
  }

  console.log(`${ids.length} id(s): ${deleted} deleted again, ${absent} not present, ${refused} refused.`);
  if (refused > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Re-applying account deletions FAILED:", error);
  process.exitCode = 1;
});
