#!/usr/bin/env bash
# Concord Nova — install or update the server on Ubuntu 22.04/24.04 (run as root).
#
# Usually started by `node deploy/push.mjs root@<ip>` from your PC, which
# uploads the sources and runs this script. Manual use from a source tree:
#   PURGE_OLD=1 bash deploy/setup.sh
#
# Environment (all optional):
#   DOMAIN       public name for HTTPS      (default: <ip-with-dashes>.sslip.io)
#   EMAIL        Let's Encrypt contact      (default: none)
#   PURGE_OLD=1  remove the old Concord install (/opt/concord, its service and
#                nginx site). Before anything is deleted it is archived to
#                /root/concord-backup-<date>.tar.gz and — when Nova is still
#                empty — its accounts, servers and messages are imported.
#   MIGRATE_OLD=0  purge without importing the old data
#   REPO / BRANCH  deploy from git instead of the uploaded source tree
#   NOVA_ADMIN   username or email of an existing account to make instance admin
#
# Safe to re-run: every run is an update. The new build is prepared next to the
# live one and swapped in only if it builds; if it then fails its health check
# the previous version is restored automatically. The database is backed up
# before every update and daily (14 days kept).
set -euo pipefail

APP_DIR=/opt/nova
DATA_DIR=/var/lib/nova
ENV_FILE=/etc/nova/nova.env
PORT=4400
ACME_ROOT=/var/www/nova-acme
OLD_DIR=/opt/concord
STAMP=$(date +%Y%m%d-%H%M%S)
SRC_DIR="${SRC_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd || true)}"
PURGE_OLD="${PURGE_OLD:-0}"
MIGRATE_OLD="${MIGRATE_OLD:-1}"

say() { printf '\n\033[1;33m▶ %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die() { printf '\n\033[31m✖ %s\033[0m\n' "$*"; exit 1; }

# Whatever this script stopped comes back if it fails half-way.
OLD_STOPPED=0
NOVA_STOPPED=0
on_exit() {
  local rc=$?
  [ "$rc" = 0 ] && return
  if [ "$OLD_STOPPED" = 1 ] && systemctl start concord >/dev/null 2>&1; then warn "old Concord restarted — nothing was removed"; fi
  if [ "$NOVA_STOPPED" = 1 ] && systemctl start nova >/dev/null 2>&1; then warn "the running Nova version was restarted"; fi
}
trap on_exit EXIT

[ "$(id -u)" = 0 ] || die "run as root"
. /etc/os-release 2>/dev/null || true
[ "${ID:-}" = ubuntu ] || [ "${ID_LIKE:-}" = debian ] || [ "${ID:-}" = debian ] || warn "tested on Ubuntu; continuing on ${PRETTY_NAME:-unknown OS}"

PUBLIC_IP=$(curl -fsS4 --max-time 8 https://api.ipify.org || curl -fsS4 --max-time 8 https://ifconfig.me || hostname -I | awk '{print $1}')
DOMAIN="${DOMAIN:-${PUBLIC_IP//./-}.sslip.io}"
echo "Concord Nova → https://${DOMAIN}  (ip ${PUBLIC_IP})"

# ── system packages ───────────────────────────────────────────────────────────
say "System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y -qq
apt-get install -y -qq curl ca-certificates git nginx ufw openssl sqlite3 tar gzip certbot >/dev/null
ok "nginx, certbot, sqlite3, ufw"

if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 2000000 ] && [ -z "$(swapon --show 2>/dev/null)" ]; then
  say "Swap (small VPS: keeps npm/vite builds from running out of memory)"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  ok "2 GB swap"
fi

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  say "Node.js 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
ok "node $(node -v)"

if ! command -v livekit-server >/dev/null; then
  say "LiveKit (voice/video SFU)"
  # Straight from the GitHub release (same source as scripts/livekit-dev.mjs).
  LK_VER=$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/livekit/livekit/releases/latest | sed 's#.*/v##')
  LK_ARCH=$(dpkg --print-architecture 2>/dev/null || echo amd64)
  curl -fsSL "https://github.com/livekit/livekit/releases/download/v${LK_VER}/livekit_${LK_VER}_linux_${LK_ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin livekit-server
  chmod 755 /usr/local/bin/livekit-server
fi
ok "livekit $(livekit-server --version 2>/dev/null | awk '{print $NF}')"

id nova >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin nova
id livekit >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin livekit
install -d -o nova -g nova -m 750 "$DATA_DIR" "$DATA_DIR/backups"
install -d -m 755 /etc/nova "$ACME_ROOT"
install -d -o livekit -g livekit -m 750 /etc/livekit

# ── old Concord: refuse to fight over ports / names unless asked to remove it ─
OLD_PRESENT=0
{ [ -d "$OLD_DIR" ] || [ -f /etc/systemd/system/concord.service ] || [ -e /etc/nginx/sites-enabled/concord ]; } && OLD_PRESENT=1
if [ "$OLD_PRESENT" = 1 ] && [ "$PURGE_OLD" != 1 ]; then
  die "The old Concord is still installed (it holds the domain and port 80).
   Re-run with PURGE_OLD=1 — it is archived to /root and its data imported before removal."
fi

# ── configuration (secrets generated once, kept on updates) ──────────────────
if [ ! -f "$ENV_FILE" ]; then
  say "Configuration"
  LK_KEY="nova$(openssl rand -hex 6)"
  LK_SECRET="$(openssl rand -hex 32)"
  cat >"$ENV_FILE" <<ENV
# Concord Nova server settings (read by nova.service). Restart after edits:
#   systemctl restart nova
NODE_ENV=production
HOST=127.0.0.1
PORT=${PORT}
PUBLIC_URL=https://${DOMAIN}
TRUST_PROXY=true
DATA_DIR=${DATA_DIR}
# open | invite | closed
REGISTRATION=open
LIVEKIT_API_KEY=${LK_KEY}
LIVEKIT_API_SECRET=${LK_SECRET}
LIVEKIT_INTERNAL_URL=http://127.0.0.1:7880
# Optional: GIF search (a key from https://partner.klipy.com — or set it in the
# app: Settings → Nova server) and password-reset mail.
KLIPY_KEY=
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
CHECKPOINT_DISABLE=1
ENV
  chmod 640 "$ENV_FILE"
  chgrp nova "$ENV_FILE"
  ok "$ENV_FILE (fresh LiveKit keys)"
fi
sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=https://${DOMAIN}|" "$ENV_FILE"
set -a
. "$ENV_FILE"
set +a

# ── TLS certificate (webroot; reuses an existing one for the same name) ──────
nginx_conf() {
  local tls="$1"
  # IPv6 listeners only where the kernel has IPv6 (nginx refuses to start otherwise).
  local v6_80d="# no IPv6 on this host" v6_80="# no IPv6 on this host" v6_443="# no IPv6 on this host"
  if [ -f /proc/net/if_inet6 ]; then
    v6_80d="listen [::]:80 default_server;"
    v6_80="listen [::]:80;"
    v6_443="listen [::]:443 ssl http2;"
  fi
  cat >/etc/nginx/snippets/nova-proxy.conf <<'NGX'
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
NGX
  cat >/etc/nginx/snippets/nova-app.conf <<NGX
client_max_body_size 0;
gzip on;
gzip_types text/css application/javascript application/json image/svg+xml text/plain;
gzip_min_length 1024;

location /.well-known/acme-challenge/ { root ${ACME_ROOT}; }

# LiveKit signaling (WebSocket) — media itself flows over UDP 50000-60000.
location /rtc {
    proxy_pass http://127.0.0.1:7880;
    include snippets/nova-proxy.conf;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$nova_upgrade;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
    proxy_buffering off;
}
location /socket.io/ {
    proxy_pass http://nova_app;
    include snippets/nova-proxy.conf;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$nova_upgrade;
    proxy_read_timeout 1h;
    proxy_buffering off;
}
# Android push (Server-Sent Events): no buffering, long-lived.
location /api/push/stream {
    proxy_pass http://nova_app;
    include snippets/nova-proxy.conf;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 1h;
}
location / {
    proxy_pass http://nova_app;
    include snippets/nova-proxy.conf;
    proxy_set_header Connection "";
    # Uploads stream straight to the app (no size cap, no temp copy).
    proxy_request_buffering off;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}
NGX
  {
    cat <<NGX
# Concord Nova — generated by deploy/setup.sh
map \$http_upgrade \$nova_upgrade { default upgrade; '' close; }
upstream nova_app { server 127.0.0.1:${PORT}; keepalive 32; }

# Plain HTTP by IP keeps working for the apps' fallback; ACME lives here too.
server {
    listen 80 default_server;
    ${v6_80d}
    server_name _;
    include snippets/nova-app.conf;
}
NGX
    if [ "$tls" = yes ]; then
      cat <<NGX

server {
    listen 80;
    ${v6_80}
    server_name ${DOMAIN};
    location /.well-known/acme-challenge/ { root ${ACME_ROOT}; }
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl http2;
    ${v6_443}
    server_name ${DOMAIN};
    ssl_certificate     /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:nova_tls:10m;
    ssl_session_timeout 1d;
    add_header Strict-Transport-Security "max-age=31536000" always;
    include snippets/nova-app.conf;
}
NGX
    fi
  } >/etc/nginx/sites-available/nova
  ln -sf /etc/nginx/sites-available/nova /etc/nginx/sites-enabled/nova
  rm -f /etc/nginx/sites-enabled/default
}

# ── build the new version next to the live one ───────────────────────────────
say "Sources"
rm -rf "$APP_DIR.new"
if [ -n "${REPO:-}" ]; then
  git clone --depth 1 --branch "${BRANCH:-main}" "$REPO" "$APP_DIR.new" >/dev/null
  ok "git $REPO (${BRANCH:-main})"
elif [ -f "$SRC_DIR/package.json" ] && grep -q '"concord-nova"' "$SRC_DIR/package.json"; then
  mkdir -p "$APP_DIR.new"
  tar -C "$SRC_DIR" --exclude=node_modules --exclude=.git -cf - . | tar -C "$APP_DIR.new" -xf -
  ok "uploaded tree $SRC_DIR"
else
  die "no sources: run from the uploaded tree (deploy/push.mjs) or set REPO=<git url>"
fi

say "Build (npm ci + server bundle + web client)"
cd "$APP_DIR.new"
export ELECTRON_SKIP_BINARY_DOWNLOAD=1 CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1
# --include=dev: NODE_ENV=production (from nova.env) would otherwise skip the
# build tools (esbuild, vite, tsx) that the build and the Concord import need.
npm ci --include=dev --no-audit --no-fund --loglevel=error
# Same-origin web build: no VITE_API_URL, the page talks to the server that serves it.
env -u VITE_API_URL npm run build >/tmp/nova-build.log 2>&1 || { tail -40 /tmp/nova-build.log; die "build failed — the live version keeps running"; }
ok "built $(node -p 'require("./package.json").version')"

# ── database: backup, then schema migrations ─────────────────────────────────
say "Database"
# Schema migrations need the database to themselves: pause the live server
# (it comes back with the new version below, or the old one on failure).
if systemctl is-active -q nova 2>/dev/null; then
  NOVA_STOPPED=1
  systemctl stop nova
fi
if [ -f "$DATA_DIR/nova.db" ]; then
  sqlite3 "$DATA_DIR/nova.db" ".backup '$DATA_DIR/backups/pre-update-$STAMP.db'"
  ls -1t "$DATA_DIR"/backups/pre-update-*.db 2>/dev/null | tail -n +11 | xargs -r rm -f
  ok "backup backups/pre-update-$STAMP.db"
fi
(cd server && node scripts/prisma.mjs migrate deploy >/dev/null)
chown -R nova:nova "$DATA_DIR"
ok "schema up to date"

# ── old Concord: archive → import → remove ───────────────────────────────────
if [ "$OLD_PRESENT" = 1 ]; then
  say "Old Concord: archive"
  # From here until it is removed, any failure brings the old service back up.
  OLD_STOPPED=1
  systemctl stop concord 2>/dev/null || true
  OLD_ENV="$OLD_DIR/.env"
  OLD_DB_URL=$(grep -E '^DATABASE_URL=' "$OLD_ENV" 2>/dev/null | cut -d= -f2- | tr -d '"'"'" || true)
  OLD_DB_PATH="${OLD_DB_URL#file:}"
  OLD_DB_PATH="${OLD_DB_PATH:-./dev.db}"
  case "$OLD_DB_PATH" in /*) OLD_DB="$OLD_DB_PATH" ;; *) OLD_DB="$OLD_DIR/server/prisma/${OLD_DB_PATH#./}" ;; esac
  OLD_UP=$(grep -E '^STORAGE_DIR=' "$OLD_ENV" 2>/dev/null | cut -d= -f2- | tr -d '"'"'" || true)
  OLD_UP="${OLD_UP:-./uploads}"
  case "$OLD_UP" in /*) OLD_UPLOADS="$OLD_UP" ;; *) OLD_UPLOADS="$OLD_DIR/server/${OLD_UP#./}" ;; esac

  BACKUP="/root/concord-backup-$STAMP.tar.gz"
  PATHS=()
  for p in "${OLD_DIR#/}" etc/systemd/system/concord.service etc/nginx/sites-available/concord; do [ -e "/$p" ] && PATHS+=("$p"); done
  if [ "${#PATHS[@]}" -gt 0 ]; then
    tar -C / --exclude='node_modules' --exclude='*/client/release' --exclude='*/client/dist-electron' -czf "$BACKUP" "${PATHS[@]}"
    # Read the whole listing first: `tar | grep -q` would SIGPIPE tar and fail under pipefail.
    LISTING=$(tar -tzf "$BACKUP") || die "backup archive is unreadable — nothing was removed"
    if [ -f "$OLD_DB" ] && ! grep -qxF "${OLD_DB#/}" <<<"$LISTING"; then
      die "old database missing from the backup — nothing was removed"
    fi
    chmod 600 "$BACKUP"
    ok "$BACKUP ($(du -h "$BACKUP" | cut -f1))"
  fi

  if [ "$MIGRATE_OLD" = 1 ] && [ -f "$OLD_DB" ]; then
    USERS=$(sqlite3 "$DATA_DIR/nova.db" 'SELECT COUNT(*) FROM "User";' 2>/dev/null || echo 0)
    if [ "$USERS" = 0 ]; then
      say "Old Concord: import accounts, servers and messages"
      if (cd server && npx tsx scripts/migrate-from-concord.ts --from "$OLD_DB" --uploads "$OLD_UPLOADS"); then
        chown -R nova:nova "$DATA_DIR"
        ok "imported"
      else
        warn "import failed — Nova's database was reset and the old install is KEPT (nothing deleted)"
        rm -f "$DATA_DIR"/nova.db "$DATA_DIR"/nova.db-*
        (cd server && node scripts/prisma.mjs migrate deploy >/dev/null)
        chown -R nova:nova "$DATA_DIR"
        die "fix the import problem above, then re-run with PURGE_OLD=1 (backup: $BACKUP)"
      fi
    else
      warn "Nova already has $USERS account(s) — old data not imported (it stays in $BACKUP)"
    fi
  fi

  say "Old Concord: remove"
  OLD_STOPPED=0
  systemctl disable --now concord 2>/dev/null || true
  rm -f /etc/systemd/system/concord.service
  systemctl daemon-reload
  rm -f /etc/nginx/sites-enabled/concord /etc/nginx/sites-available/concord
  if systemctl is-enabled coturn >/dev/null 2>&1; then
    systemctl disable --now coturn >/dev/null 2>&1 || true
    warn "coturn stopped (LiveKit has its own TURN on 3478/5349)"
  fi
  rm -rf "$OLD_DIR"
  ok "service, nginx site and $OLD_DIR removed — archive kept at $BACKUP"
fi

# ── instance admin (push.mjs --admin <login>) ────────────────────────────────
if [ -n "${NOVA_ADMIN:-}" ]; then
  say "Admin rights"
  if (cd server && npx tsx scripts/grant-admin.ts "$NOVA_ADMIN"); then ok "granted"; else warn "not granted (see above) — the rest of the update continues"; fi
  chown -R nova:nova "$DATA_DIR"
fi

# ── nginx + certificate ──────────────────────────────────────────────────────
say "nginx + HTTPS"
if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  nginx_conf yes
else
  nginx_conf no
  nginx -t -q && systemctl reload nginx
  CB_MAIL=(--register-unsafely-without-email)
  [ -n "${EMAIL:-}" ] && CB_MAIL=(-m "$EMAIL")
  certbot certonly --webroot -w "$ACME_ROOT" -d "$DOMAIN" --non-interactive --agree-tos "${CB_MAIL[@]}" >/dev/null 2>&1 \
    && nginx_conf yes || warn "certificate failed (DNS/port 80?) — serving plain HTTP for now; re-run later"
fi
# Renewals reload nginx and hand the certificate to LiveKit's TURN/TLS.
install -d /etc/letsencrypt/renewal-hooks/deploy
cat >/etc/letsencrypt/renewal-hooks/deploy/nova.sh <<HOOK
#!/bin/sh
install -o livekit -g livekit -m 600 /etc/letsencrypt/live/${DOMAIN}/fullchain.pem /etc/livekit/turn.crt
install -o livekit -g livekit -m 600 /etc/letsencrypt/live/${DOMAIN}/privkey.pem /etc/livekit/turn.key
systemctl reload nginx
systemctl try-restart livekit
HOOK
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/nova.sh
nginx -t -q || die "nginx config test failed"
systemctl enable -q nginx && systemctl reload nginx
[ -d "/etc/letsencrypt/live/$DOMAIN" ] && ok "https://$DOMAIN" || warn "HTTP only"

# ── LiveKit ──────────────────────────────────────────────────────────────────
say "LiveKit"
TURN_TLS=""
if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  install -o livekit -g livekit -m 600 "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" /etc/livekit/turn.crt
  install -o livekit -g livekit -m 600 "/etc/letsencrypt/live/$DOMAIN/privkey.pem" /etc/livekit/turn.key
  TURN_TLS="  tls_port: 5349
  cert_file: /etc/livekit/turn.crt
  key_file: /etc/livekit/turn.key"
fi
cat >/etc/livekit/livekit.yaml <<YAML
# Generated by deploy/setup.sh — signaling on 127.0.0.1:7880 behind nginx (/rtc).
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true
keys:
  ${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}
webhook:
  api_key: ${LIVEKIT_API_KEY}
  urls:
    - http://127.0.0.1:${PORT}/api/voice/webhook
turn:
  enabled: true
  domain: ${DOMAIN}
  udp_port: 3478
${TURN_TLS}
room:
  auto_create: true
  empty_timeout: 300
logging:
  level: info
YAML
chown livekit:livekit /etc/livekit/livekit.yaml
chmod 600 /etc/livekit/livekit.yaml
cat >/etc/systemd/system/livekit.service <<UNIT
[Unit]
Description=LiveKit SFU for Concord Nova
After=network-online.target
Wants=network-online.target

[Service]
User=livekit
ExecStart=$(command -v livekit-server) --config /etc/livekit/livekit.yaml
Restart=always
RestartSec=2
LimitNOFILE=500000

[Install]
WantedBy=multi-user.target
UNIT

# ── firewall ─────────────────────────────────────────────────────────────────
say "Firewall"
# Never lock ourselves out: also allow whatever port sshd really listens on.
if (
  { ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null; } &&
    for p in $(ss -Htlnp 2>/dev/null | awk '/sshd/ {n = split($4, a, ":"); print a[n]}' | sort -u); do ufw allow "$p/tcp" >/dev/null || exit 1; done &&
    for r in 80/tcp 443/tcp 7881/tcp 3478/udp 5349/tcp 50000:60000/udp; do ufw allow "$r" >/dev/null || exit 1; done &&
    ufw --force enable >/dev/null
); then
  ok "ssh, http(s), webrtc 7881/tcp 50000-60000/udp, turn 3478/udp 5349/tcp"
else
  warn "ufw could not be configured — open these ports in your provider's firewall: 80,443,7881/tcp 5349/tcp 3478/udp 50000-60000/udp"
fi

# ── services ─────────────────────────────────────────────────────────────────
cat >/etc/systemd/system/nova.service <<UNIT
[Unit]
Description=Concord Nova server
After=network-online.target livekit.service
Wants=network-online.target

[Service]
User=nova
Group=nova
EnvironmentFile=${ENV_FILE}
WorkingDirectory=${APP_DIR}/server
ExecStartPre=/usr/bin/node scripts/prisma.mjs migrate deploy
ExecStart=/usr/bin/node --enable-source-maps dist/index.js
Restart=always
RestartSec=2
TimeoutStopSec=20
LimitNOFILE=65535
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
UNIT

cat >/usr/local/bin/nova-backup <<'SH'
#!/bin/sh
# Daily database snapshot for Concord Nova (14 days kept).
set -e
D=/var/lib/nova/backups
sqlite3 /var/lib/nova/nova.db ".backup '$D/daily-$(date +%F).db'"
gzip -f "$D/daily-$(date +%F).db"
find "$D" -name 'daily-*.db.gz' -mtime +14 -delete
SH
chmod 755 /usr/local/bin/nova-backup
cat >/etc/systemd/system/nova-backup.service <<'UNIT'
[Unit]
Description=Concord Nova database backup
[Service]
Type=oneshot
User=nova
ExecStart=/usr/local/bin/nova-backup
UNIT
cat >/etc/systemd/system/nova-backup.timer <<'UNIT'
[Unit]
Description=Daily Concord Nova database backup
[Timer]
OnCalendar=*-*-* 04:30:00
RandomizedDelaySec=30m
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable -q livekit nova nova-backup.timer
systemctl restart livekit
systemctl start nova-backup.timer

# ── swap in the new version, roll back if it doesn't come up ─────────────────
say "Start"
healthy() {
  for _ in $(seq 1 40); do
    curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}
NOVA_STOPPED=0 # from here the swap/rollback below owns the service
rm -rf "$APP_DIR.prev"
[ -d "$APP_DIR" ] && mv "$APP_DIR" "$APP_DIR.prev"
mv "$APP_DIR.new" "$APP_DIR"
cd /
systemctl restart nova
if ! healthy; then
  journalctl -u nova -n 40 --no-pager || true
  if [ -d "$APP_DIR.prev" ]; then
    warn "new version is unhealthy — rolling back"
    rm -rf "$APP_DIR"
    mv "$APP_DIR.prev" "$APP_DIR"
    systemctl restart nova
    healthy && die "rolled back to the previous version (see the log above)"
  fi
  die "Nova did not start — see: journalctl -u nova -e"
fi
rm -rf "$APP_DIR.prev"
ok "nova is up on 127.0.0.1:${PORT}"

URL="http://${PUBLIC_IP}"
if [ -d "/etc/letsencrypt/live/$DOMAIN" ] && curl -fsS --max-time 10 "https://${DOMAIN}/health" >/dev/null 2>&1; then
  URL="https://${DOMAIN}"
fi
ADMINS=$(sqlite3 "$DATA_DIR/nova.db" 'SELECT group_concat("username", ", ") FROM "User" WHERE ("flags" & 1) != 0 AND "disabledAt" IS NULL;' 2>/dev/null || true)
cat <<DONE

✅ Concord Nova is live: ${URL}
   Admins:   ${ADMINS:-none yet — re-run the deploy and enter your login when asked} (app: Settings → Nova server)
   Logs:     journalctl -u nova -f   |   journalctl -u livekit -f
   Settings: ${ENV_FILE}  (then: systemctl restart nova)
   Backups:  ${DATA_DIR}/backups
DONE
