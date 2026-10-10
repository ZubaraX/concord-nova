#!/usr/bin/env bash
# Concord Nova at home: until the server has its HTTPS certificate, try for it
# every 20 minutes (nova-https.timer). It comes once the router forwards port 80
# here; then deploy/setup.sh runs once more and switches nginx and LiveKit to it.
# (Not more often: Let's Encrypt allows only a few failed tries an hour.)
set -uo pipefail
LOG=/var/log/nova-install.log

IP=$(curl -fsS4 --max-time 8 https://api.ipify.org || curl -fsS4 --max-time 8 https://ifconfig.me) || exit 0
DOMAIN="${IP//./-}.sslip.io"
done_() {
  systemctl disable -q --now nova-https.timer
  /usr/local/bin/nova-status >/dev/null
}
[ -d "/etc/letsencrypt/live/$DOMAIN" ] && grep -q "^PUBLIC_URL=https://$DOMAIN$" /etc/nova/nova.env && { done_; exit 0; }

if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  certbot certonly --webroot -w /var/www/nova-acme -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email -q >/dev/null 2>&1 || exit 0
fi
echo "$(date '+%F %T') HTTPS: certificate for $DOMAIN — finishing the set-up with it" >>"$LOG"
(cd /opt/nova-usb/src && bash deploy/setup.sh) >>"$LOG" 2>&1 && done_
