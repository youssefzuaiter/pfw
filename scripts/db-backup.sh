#!/usr/bin/env bash
# Encrypted logical backup of a PFW database (AGENTS.md §3yy).
#
#   BACKUP_DATABASE_URL='postgresql://backup_reader:...@host/db?sslmode=require' \
#   BACKUP_PASSPHRASE='...' scripts/db-backup.sh <output-dir>
#
# Produces <output-dir>/pfw-<UTC stamp>.pgdump.gpg: a pg_dump custom-format
# archive (compressed, restorable table-by-table with pg_restore),
# symmetrically encrypted with AES-256 under BACKUP_PASSPHRASE. The
# plaintext archive never leaves this script — it is removed the moment
# the encrypted copy has been verified, and the verification is a real
# decrypt-and-list round trip (not a checksum), so a wrong passphrase or a
# truncated archive fails HERE, on the night it happens, not on the day a
# restore is needed. Restore steps: docs/BACKUP-RESTORE.md.
#
# Why the roles and the crypto look the way they do:
#   - The connection is the read-only, RLS-bypassing `backup_reader` role
#     (prisma/migrations/20260902100000_backup_reader_role): BYPASSRLS is
#     what makes the dump complete — every user's rows, not the zero rows
#     RLS fails closed to when no request context is set — and SELECT-only
#     is what keeps a leaked backup credential from being a write path.
#   - `--no-owner --no-privileges`: ownership and grants name roles
#     (pfw_app / the Neon owner / pfw_runtime) that a restore target may not
#     have; they are re-created from the migrations instead (see the doc).
#   - pg_dump runs from the official postgres image rather than whatever
#     client the host ships: pg_dump refuses a server NEWER than itself, and
#     the GitHub runner's bundled client trails the production server.
#     PG_DUMP_IMAGE overrides the tag if the server major version moves.
#   - GnuPG symmetric mode, passphrase over stdin (`--passphrase-fd 0`),
#     never on the command line — argv is visible to every process on the
#     host. The workflow's artifacts are downloadable by anyone with read
#     access to this PUBLIC repository, which is why nothing unencrypted is
#     ever uploaded.
set -euo pipefail

OUT_DIR="${1:?usage: $0 <output-dir>}"
: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is required (a backup_reader connection string)}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required}"
PG_DUMP_IMAGE="${PG_DUMP_IMAGE:-postgres:17}"

case "$BACKUP_DATABASE_URL" in
  postgresql://*|postgres://*) ;;
  *)
    # libpq treats anything that is not a URL as a bare database NAME and
    # dials the local socket — the first real run did exactly that with a
    # secret that held only the password. Say so instead.
    echo "BACKUP_DATABASE_URL must be a full connection string starting with postgresql:// (got ${#BACKUP_DATABASE_URL} characters that do not)" >&2
    exit 2
    ;;
esac
if [ "${#BACKUP_PASSPHRASE}" -lt 20 ]; then
  echo "BACKUP_PASSPHRASE must be at least 20 characters — this is the only thing protecting a public artifact" >&2
  exit 2
fi
for tool in docker gpg; do
  command -v "$tool" >/dev/null || { echo "$tool is required but not installed" >&2; exit 2; }
done

mkdir -p "$OUT_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
PLAIN="$OUT_DIR/pfw-$STAMP.pgdump"
ENCRYPTED="$PLAIN.gpg"
trap 'rm -f "$PLAIN"' EXIT

echo "1/3 pg_dump ($PG_DUMP_IMAGE) → $(basename "$PLAIN")"
# The URL is passed INTO the container as an environment variable and only
# expanded by the container's own shell (single quotes), so it appears in
# no argv on either side.
docker run --rm --pull=missing \
  -e BACKUP_DATABASE_URL \
  --add-host=host.docker.internal:host-gateway \
  "$PG_DUMP_IMAGE" \
  sh -c 'exec pg_dump --format=custom --compress=6 --no-owner --no-privileges --dbname="$BACKUP_DATABASE_URL"' \
  > "$PLAIN"
PLAIN_BYTES=$(wc -c < "$PLAIN" | tr -d ' ')
if [ "$PLAIN_BYTES" -lt 1024 ]; then
  echo "dump is only $PLAIN_BYTES bytes — that is not a database" >&2
  exit 1
fi

echo "2/3 encrypt → $(basename "$ENCRYPTED")"
printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --yes --quiet \
  --symmetric --cipher-algo AES256 \
  --s2k-mode 3 --s2k-digest-algo SHA512 --s2k-count 65011712 \
  --pinentry-mode loopback --passphrase-fd 0 \
  --output "$ENCRYPTED" "$PLAIN"

echo "3/3 verify: decrypt the artifact and read its table of contents"
TOC=$(printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --quiet --decrypt \
  --pinentry-mode loopback --passphrase-fd 0 "$ENCRYPTED" \
  | docker run --rm -i "$PG_DUMP_IMAGE" pg_restore --list)
TABLES=$(printf '%s\n' "$TOC" | grep -c ' TABLE DATA ' || true)
if [ "$TABLES" -lt 10 ]; then
  echo "archive lists only $TABLES tables of data — refusing to call that a backup" >&2
  exit 1
fi

rm -f "$PLAIN"
echo "ok: $(basename "$ENCRYPTED") — $(wc -c < "$ENCRYPTED" | tr -d ' ') bytes encrypted, $TABLES tables, dump taken $STAMP"
