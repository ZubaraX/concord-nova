#!/usr/bin/env bash
# Concord Nova — moving the server, step 1 (on the OLD server, as root):
# stops Concord Nova (from here its data no longer changes) and writes all of
# it to stdout as a .tar.gz: a consistent copy of the database (move.db), the
# uploaded files, the server's secret (.jwt-secret — sessions and media links
# stay valid), and the settings that live in nova.env, not in the database
# (move.env). If anything fails, Concord Nova is started again.
#   ssh root@old 'bash -s' < export.sh > nova-move.tar.gz
set -euo pipefail
D=/var/lib/nova
ENV_FILE=/etc/nova/nova.env

done_ok=0
trap '[ "$done_ok" = 1 ] || { systemctl start nova; echo "nova-move: export failed — Concord Nova is running again here" >&2; }; rm -f "$D/move.db" "$D/move.env"' EXIT

echo "nova-move: $(du -sh --exclude=backups --exclude=cache "$D" | cut -f1) to move; stopping Concord Nova here" >&2
systemctl stop nova
rm -f "$D/move.db" "$D/move.env"
sqlite3 "$D/nova.db" ".backup '$D/move.db'"
grep -E '^(KLIPY_KEY|SMTP_[A-Z]+|REGISTRATION)=' "$ENV_FILE" >"$D/move.env" || true
tar -C "$D" -czf - --exclude=./nova.db --exclude=./nova.db-wal --exclude=./nova.db-shm --exclude=./backups --exclude=./cache --exclude=./.cache .
done_ok=1
echo "nova-move: exported; Concord Nova stays stopped here until the move is finished" >&2
