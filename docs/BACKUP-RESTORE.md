# Database backup & restore

The production database (Neon) has two independent recovery paths. Use
them in this order.

| | What it covers | Where |
|---|---|---|
| **1. Neon point-in-time restore** | "I deleted the wrong rows an hour ago." Any moment inside Neon's history window, to the second, as a new branch. | Neon console → Branches → Restore |
| **2. Nightly encrypted `pg_dump`** | "The Neon project is gone / the account lapsed / we are leaving the provider." A complete logical copy, off-provider, one per night, 30 days deep. | GitHub → Actions → *Database backup* → the run → Artifacts |

Path 2 is what this document is about. It is produced by
`.github/workflows/db-backup.yml`, which runs `scripts/db-backup.sh`
every night at 03:30 UTC and on demand (*Run workflow*).

## What a backup contains

`pfw-<UTC stamp>.pgdump.gpg` — a `pg_dump --format=custom` archive of the
whole `public` schema (every table's rows, the RLS policies, the
append-only triggers, the SECURITY DEFINER helper functions, and
`_prisma_migrations`, so a restored database already knows which
migrations it carries), encrypted with AES-256 under `BACKUP_PASSPHRASE`.

Field-level encryption is preserved as-is: `NotableTransaction.description`,
`BankAccount.last4`, `User.totpSecret` and the rest are ciphertext in the
dump exactly as they are in the table. **A restored database is only
readable with the same `ENCRYPTION_KEY` the app was using when the dump
was taken** — keep that key with the passphrase, in the password manager,
and never rotate one without the other in mind (`docs/SECURITY-CHECKLIST.md`,
"Secret rotation").

**A backup taken while an `ENCRYPTION_KEY` rotation is actively in
progress** (`ENCRYPTION_KEY_NEXT` set, `src/server/crypto/key-rotation.ts`'s
sweep mid-run) will genuinely contain a MIX of rows still under the old
key and rows already re-keyed onto the new one — this is expected and
fully recoverable, not a corrupted dump: restore with BOTH
`ENCRYPTION_KEY` (the old value) and `ENCRYPTION_KEY_NEXT` (the new
value) set exactly as they were at backup time, and every row decrypts
correctly regardless of which one it's actually under. Restoring with
only the OLD key set (dropping `ENCRYPTION_KEY_NEXT`) would leave
whatever had already been re-keyed at backup time undecryptable — keep
both values together with the passphrase for the whole rotation window,
not just the final one.

**Which key a given artifact needs**: every `v2:` row names its key by
fingerprint (12 hex characters after `v2:`), and `GET /api/cron`'s
`encryptionKeyRotation.currentKeyId` names the key the app is running on.
`printf '%s' "$KEY" | base64 -d | shasum -a 256 | cut -c1-12` on a
candidate key tells you whether it is the one. The production key was
rotated on 2026-09-20 (AGENTS.md §3zz): artifacts from 2026-09-21 on are
under `474463b5c95e`, the key on file; the artifacts before that were
encrypted under `0cf456d07242`, a key that was never recorded anywhere
and cannot be recovered — they are complete dumps, but their encrypted
columns are unreadable.

What it deliberately does NOT contain: roles (`pg_dump` never dumps
roles — they are cluster-level), ownership, and grants
(`--no-owner --no-privileges`). All three are recreated from the
migrations in step 4 below.

## One-time setup (operator)

1. **Apply the grants migration.** Run the *Deploy Migrations* workflow so
   `20260918140000_grants_follow_the_migrating_role` lands. Until it does,
   `backup_reader` cannot read any table created after 2026-09-02 and the
   first backup fails on `UserSettings` with "permission denied".
2. **Give `backup_reader` a password.** The role was created without one
   (its original design was mTLS-only, `future-infra/`). In Neon's SQL
   editor, as the project owner:
   ```sql
   ALTER ROLE backup_reader WITH PASSWORD '<generated, 32+ characters>';
   ```
   Neon requires passwords with at least 60 bits of entropy; a
   password-manager-generated string satisfies that.
3. **Create the `backup` GitHub Environment** (Settings → Environments →
   New environment → `backup`, no protection rules — see the workflow
   header for why it cannot be `production`) and add two environment
   secrets:
   - `BACKUP_DATABASE_URL` — `postgresql://backup_reader:<pw>@<host>/neondb?sslmode=require`,
     using the **direct** host (drop `-pooler` from the hostname Neon
     shows you).
   - `BACKUP_PASSPHRASE` — generated, at least 20 characters, and stored
     in the password manager under a name you will find in five years.
4. **Run it once by hand** (Actions → *Database backup* → *Run workflow*)
   and read the log: the last line is
   `ok: pfw-….pgdump.gpg — N bytes encrypted, 42 tables, dump taken …`.
   The table count is the whole schema; a smaller number means the
   grants migration has not been applied.

## Restore

Restore into a **new, empty database** — never over the live one. On
Neon that is a new project (or a new branch with its data wiped); locally
it is `CREATE DATABASE`. Verify there, then repoint `APP_DATABASE_URL`.

1. **Download** the artifact from the run you want (Actions → *Database
   backup* → pick the night → Artifacts). Unzip it; inside is one
   `.pgdump.gpg`.
2. **Decrypt** (prompts for the passphrase, or pipe it in as the script
   does):
   ```bash
   gpg --decrypt --output pfw.pgdump pfw-20260918T033000Z.pgdump.gpg
   ```
3. **Inspect before touching anything** — this is the same round trip the
   nightly job already ran, so it should list every table:
   ```bash
   docker run --rm -i postgres:18 pg_restore --list < pfw.pgdump | grep -c 'TABLE DATA'
   ```
4. **Recreate the roles** in the target (they are not in the dump). As the
   target's owner role:
   ```sql
   CREATE ROLE pfw_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
     PASSWORD '<new generated password — this becomes APP_DATABASE_URL>';
   CREATE ROLE backup_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS
     CONNECTION LIMIT 3 PASSWORD '<new generated password>';
   ```
   (`BYPASSRLS` needs a role allowed to grant it — the Neon owner can; on
   a self-hosted Postgres use a superuser for this one statement.)
5. **Restore the schema and data**, as the target's owner role, against
   the direct endpoint:
   ```bash
   docker run --rm -i postgres:18 pg_restore --no-owner --no-privileges --exit-on-error \
     --dbname='postgresql://<owner>:<pw>@<direct host>/<db>?sslmode=require' < pfw.pgdump
   ```
   `--exit-on-error` is deliberate: a partial restore that "mostly worked"
   is worse than a clear failure you can fix and re-run into a fresh
   database.
6. **Re-apply the grants** — run the grants migration verbatim; it is
   idempotent and is the single source of truth for what each role may do:
   ```bash
   psql 'postgresql://<owner>:<pw>@<direct host>/<db>?sslmode=require' \
     -f prisma/migrations/20260918140000_grants_follow_the_migrating_role/migration.sql
   ```
7. **Verify**, as the owner:
   ```sql
   SELECT count(*) FROM "User";                         -- matches the source
   SELECT count(*) FROM pg_class WHERE relforcerowsecurity;  -- every user table (37 as of 2026-09-18)
   SELECT count(*) FROM _prisma_migrations;             -- 33 as of 2026-09-18
   ```
   then `npx prisma migrate status` against the target must say
   `Database schema is up to date!` — if it lists pending migrations, the
   dump predates them: run *Deploy Migrations* against the target.
8. **Point the app at it**: set `APP_DATABASE_URL` (Vercel → Project →
   Environment Variables) to the `pfw_runtime` string from step 4, keep
   `ENCRYPTION_KEY` unchanged, redeploy, and run
   `scripts/production-smoke.sh <deployment-url>`.
9. **Update the backup credential** so tonight's run targets the new
   database: `BACKUP_DATABASE_URL` in the `backup` environment.

### Rehearsed

This exact sequence (dump as `backup_reader` → encrypt → wrong passphrase
rejected → decrypt → `pg_restore --exit-on-error` into a fresh database →
per-table row counts diffed against the source) was run against the local
database on 2026-09-18: 42 tables, every count identical except the
rate-limit table the still-running dev server kept writing to, RLS forced
on 37 tables, 55 policies, both append-only triggers, ciphertext intact.
Rehearse it again after any migration that adds a role, a trigger, or a
SECURITY DEFINER function — those are the objects a logical restore is
most likely to get subtly wrong.

## Known limits

- **30 restore points, nightly granularity.** Anything finer is Neon's
  point-in-time restore.
- **Artifacts are public-downloadable; the passphrase is the whole
  defense.** AES-256 with a 20+ character generated passphrase is not the
  weak link; a passphrase pasted into a chat or a ticket is. Rotate it by
  changing the environment secret — old artifacts stay under the old one
  until they age out.
- **The `pg_dump` image follows the server.** `pg_dump` refuses a server
  newer than itself, so the script asks the server its version first and
  pulls the matching `postgres:<major>` image (Neon was already on 18
  when the first production run assumed 17). `PG_DUMP_IMAGE` still
  overrides it; `PG_PROBE_IMAGE` (default `postgres:18`) is only used
  for that one `SHOW server_version_num` query and can be anything with
  a `psql` in it.
- **GitHub disables `schedule` after 60 days without commits.** The
  Actions tab's run list is the heartbeat; the cron operator alert
  (`OPERATOR_ALERT_EMAIL`) does not cover this workflow, because a run
  that never starts cannot send anything.
