#!/usr/bin/env bash
# Concord Nova — moving the server, step 2 (on the NEW server, as root): takes
# the archive from export.sh on stdin and puts it in place of this server's
# data — the database, the uploaded files, the server's secret, the settings
# from the old nova.env — keeping this server's own address and LiveKit keys.
# What was here before is kept in backups/before-move-<time>.db. Refuses to
# overwrite a server that already has accounts, unless NOVA_MOVE_FORCE=1.
#   ssh new 'sudo bash import.sh' < nova-move.tar.gz
set -euo pipefail
D=/var/lib/nova
ENV_FILE=/etc/nova/nova.env
PORT=$(sed -n 's/^PORT=//p' "$ENV_FILE")
STAMP=$(date +%Y%m%d-%H%M%S)

USERS=$(sqlite3 "$D/nova.db" 'SELECT COUNT(*) FROM "User";' 2>/dev/null || echo 0)
if [ "$USERS" != 0 ] && [ "${NOVA_MOVE_FORCE:-0}" != 1 ]; then
  echo "nova-move: this server already has $USERS account(s) — not overwriting it (NOVA_MOVE_FORCE=1 to do it anyway)" >&2
  exit 1
fi

IN=$(mktemp -d /var/lib/nova-move.XXXXXX)
trap 'rm -rf "$IN"' EXIT
tar -xzf - -C "$IN"
[ -s "$IN/move.db" ] || { echo "nova-move: no database in the archive" >&2; exit 1; }
sqlite3 "$IN/move.db" 'PRAGMA integrity_check;' | grep -qx ok || { echo "nova-move: the database in the archive is damaged" >&2; exit 1; }

systemctl stop nova
install -d -o nova -g nova "$D/backups"
[ -f "$D/nova.db" ] && sqlite3 "$D/nova.db" ".backup '$D/backups/before-move-$STAMP.db'"
rm -f "$D/nova.db" "$D/nova.db-wal" "$D/nova.db-shm"
mv "$IN/move.db" "$D/nova.db"

# The old server's settings that lived in nova.env (GIF key, mail, registration).
if [ -s "$IN/move.env" ]; then
  cp -p "$ENV_FILE" "$ENV_FILE.before-move"
  while IFS= read -r line; do
    key=${line%%=*}
    [ -n "${line#*=}" ] || continue
    awk -v k="$key" -v l="$line" 'BEGIN { s = 0 } index($0, k "=") == 1 { print l; s = 1; next } { print } END { if (!s) print l }' "$ENV_FILE" >"$ENV_FILE.new"
    cat "$ENV_FILE.new" >"$ENV_FILE" # (keeps the file's owner and mode)
    rm -f "$ENV_FILE.new"
  done <"$IN/move.env"
fi
rm -f "$IN/move.env"

# The rest — uploaded files, .jwt-secret — over this server's.
cp -a "$IN"/. "$D"/
chown -R nova:nova "$D"
systemctl start nova
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null || { journalctl -u nova -n 30 --no-pager; echo "nova-move: Concord Nova did not start with the moved data" >&2; exit 1; }
q() { sqlite3 "$D/nova.db" "SELECT COUNT(*) FROM \"$1\";" 2>/dev/null || echo "?"; }
echo "nova-move: imported — accounts $(q User), servers $(q Guild), messages $(q Message), files $(find "$D/uploads" -type f 2>/dev/null | wc -l)"
