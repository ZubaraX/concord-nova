#!/usr/bin/env bash
# Concord Nova — what this server is up to: its addresses, HTTPS, the ports the
# router must forward. Printed after installing, and written to the login
# screen (/etc/issue.d) and to the SSH greeting (motd).  Any time:  nova-status
set -uo pipefail

LAN=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')
LAN=${LAN:-$(hostname -I 2>/dev/null | awk '{print $1}')}
DOMAIN="" HTTPS=no
# Only root reads the settings and the certificates; others see what root's last look saw.
SEEN=/opt/nova-usb/status.env
if [ "$(id -u)" = 0 ]; then
  [ -r /etc/nova/nova.env ] && DOMAIN=$(sed -n 's|^PUBLIC_URL=https://||p' /etc/nova/nova.env)
  [ -n "$DOMAIN" ] && [ -d "/etc/letsencrypt/live/$DOMAIN" ] && HTTPS=yes
  [ -d /opt/nova-usb ] && printf 'DOMAIN=%s\nHTTPS=%s\n' "$DOMAIN" "$HTTPS" >"$SEEN"
elif [ -r "$SEEN" ]; then
  . "$SEEN"
fi

if [ -f /opt/nova-usb/.installed ] && systemctl is-active -q nova; then
  STATE="работает"
  if [ "$HTTPS" = yes ]; then
    NET="https://$DOMAIN"
  else
    NET="https://$DOMAIN — заработает, когда роутер пробросит порты (проверка каждые 20 минут)"
  fi
elif [ -f /opt/nova-usb/.installed ]; then
  STATE="установлен, но сейчас не запущен (sudo systemctl status nova)"
  NET="https://$DOMAIN"
else
  STATE="ещё устанавливается (журнал: /var/log/nova-install.log)"
  NET="—"
fi

TEXT="
  Concord Nova — сервер $STATE
    В локальной сети:   http://${LAN:-?}
    Из интернета:       $NET
    Проброс портов на роутере (на адрес ${LAN:-этого компьютера}):
      TCP 80, 443, 7881, 5349      UDP 3478, 50000-60000
    Журнал установки: /var/log/nova-install.log   Повторить установку: sudo nova-install
"
printf '%s\n' "$TEXT"

if [ "$(id -u)" = 0 ]; then
  install -d /etc/issue.d
  # The login screen: \4 is filled in by the console with the current local address.
  live='http://\4'
  printf '%s\n' "${TEXT//"http://${LAN:-?}"/"$live"}" >/etc/issue.d/50-nova.issue
  printf '#!/bin/sh\nexec /usr/local/bin/nova-status 2>/dev/null\n' >/etc/update-motd.d/99-nova
  chmod 755 /etc/update-motd.d/99-nova
fi
