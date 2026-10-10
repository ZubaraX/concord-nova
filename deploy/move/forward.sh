#!/usr/bin/env bash
# Concord Nova — moving the server, step 3 (on the OLD server, as root): this
# server stops being Concord Nova and forwards everything to the new one —
# the apps built with its address keep working (calls' sound goes straight to
# the new server). Its own Nova and LiveKit are switched off for good, and
# automatic deploys here are refused (they would bring the old copy back).
#   ssh root@old 'bash -s -- <new domain> <new ip>' < forward.sh
#   Undo: cp /etc/nginx/sites-available/nova.before-move /etc/nginx/sites-available/nova; systemctl enable --now nova livekit
set -euo pipefail
NEW_DOMAIN=$1
NEW_IP=$2
OLD_DOMAIN=$(sed -n 's|^PUBLIC_URL=https://||p' /etc/nova/nova.env)
ACME_ROOT=/var/www/nova-acme

curl -fsS --max-time 15 "https://$NEW_DOMAIN/health" >/dev/null || { echo "nova-move: https://$NEW_DOMAIN does not answer — nothing changed here" >&2; exit 1; }
[ -f "/etc/letsencrypt/live/$OLD_DOMAIN/fullchain.pem" ] || { echo "nova-move: no certificate for $OLD_DOMAIN here" >&2; exit 1; }

v6_80="# no IPv6 on this host" v6_443="# no IPv6 on this host"
if [ -f /proc/net/if_inet6 ]; then v6_80="listen [::]:80 default_server;"; v6_443="listen [::]:443 ssl http2;"; fi

cat >/etc/nginx/snippets/nova-forward.conf <<NGX
proxy_pass https://${NEW_IP};
proxy_ssl_server_name on;
proxy_ssl_name ${NEW_DOMAIN};
proxy_ssl_verify on;
proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
proxy_ssl_verify_depth 3;
proxy_http_version 1.1;
proxy_set_header Host ${NEW_DOMAIN};
proxy_set_header X-Real-IP \$remote_addr;
proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto \$scheme;
proxy_set_header Upgrade \$http_upgrade;
proxy_set_header Connection \$nova_upgrade;
proxy_read_timeout 1h;
proxy_send_timeout 1h;
proxy_buffering off;
proxy_request_buffering off;
client_max_body_size 0;
add_header X-Nova-Forwarded-To ${NEW_DOMAIN} always;
NGX

[ -f /etc/nginx/sites-available/nova.before-move ] || cp /etc/nginx/sites-available/nova /etc/nginx/sites-available/nova.before-move
cat >/etc/nginx/sites-available/nova <<NGX
# Concord Nova moved to https://${NEW_DOMAIN} — this server only forwards to it.
# (Written by deploy/move/forward.sh; the previous site is nova.before-move.)
map \$http_upgrade \$nova_upgrade { default upgrade; '' close; }

server {
    listen 80 default_server;
    ${v6_80}
    server_name _;
    location /.well-known/acme-challenge/ { root ${ACME_ROOT}; }
    location / { include snippets/nova-forward.conf; }
}

server {
    listen 443 ssl http2;
    ${v6_443}
    server_name ${OLD_DOMAIN};
    ssl_certificate     /etc/letsencrypt/live/${OLD_DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${OLD_DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    location / { include snippets/nova-forward.conf; }
}
NGX
nginx -t -q
systemctl reload nginx
systemctl disable -q --now nova livekit 2>/dev/null || true

# Automatic deploys (GitHub Actions) would rebuild the old copy here: refuse them, loudly.
if [ -f /usr/local/bin/nova-ci-deploy ]; then
  cat >/usr/local/bin/nova-ci-deploy <<SH
#!/bin/sh
echo "Concord Nova moved to https://${NEW_DOMAIN}; this server only forwards to it. Point DEPLOY_HOST at the new server." >&2
exit 1
SH
  chmod 755 /usr/local/bin/nova-ci-deploy
fi
echo "nova-move: https://${OLD_DOMAIN} now forwards to https://${NEW_DOMAIN}"
