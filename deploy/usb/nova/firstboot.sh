#!/usr/bin/env bash
# Concord Nova — the first start of a server installed from the USB stick.
#
# Puts Node.js and LiveKit from the stick in place (nothing to fetch from GitHub
# or NodeSource), then installs the server with deploy/setup.sh — the same
# script that installs and updates a VPS — from the sources on the stick.
# Then shows the server's addresses on the screen. Ubuntu packages, npm
# packages and the HTTPS certificate come from the internet, so the computer
# must be connected (a cable is best).
#
# Runs once by itself (nova-firstboot.service); again any time:  sudo nova-install
set -uo pipefail

USB=/opt/nova-usb
SRC=$USB/src
LOG=/var/log/nova-install.log

exec > >(tee -a "$LOG") 2>&1
say() { printf '\n\033[1;36m■ Concord Nova: %s\033[0m\n' "$*"; }
fail() {
  say "установка не закончена: $*"
  echo "  Журнал: $LOG. Установка повторится при следующем включении,"
  echo "  или запустите её сейчас:  sudo nova-install"
  bash "$USB/nova-status.sh" || true
  exit 1
}

[ "$(id -u)" = 0 ] || { echo "run as root: sudo nova-install"; exit 1; }
say "установка сервера ($(date '+%F %T'))"
install -m 755 "$USB/nova-status.sh" /usr/local/bin/nova-status
printf '#!/bin/sh\nexec /bin/bash /opt/nova-usb/firstboot.sh "$@"\n' >/usr/local/bin/nova-install
chmod 755 /usr/local/bin/nova-install
nova-status >/dev/null

# ── internet ─────────────────────────────────────────────────────────────────
waited=0
until curl -fsS4 --max-time 8 -o /dev/null https://api.ipify.org || curl -fsS4 --max-time 8 -o /dev/null https://ifconfig.me; do
  [ $((waited % 60)) = 0 ] && say "жду интернет — подключите кабель к роутеру (проверяю каждые 10 секунд)"
  sleep 10
  waited=$((waited + 10))
done

# ── a server that never sleeps (laptops: the lid stays shut) ─────────────────
install -d /etc/systemd/logind.conf.d
cat >/etc/systemd/logind.conf.d/nova-server.conf <<'CONF'
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
HandleSuspendKey=ignore
IdleAction=ignore
CONF
systemctl mask -q sleep.target suspend.target hibernate.target hybrid-sleep.target 2>/dev/null || true

# ── Node.js and LiveKit from the stick ───────────────────────────────────────
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 24 ]; then
  say "Node.js"
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xJf "$USB"/runtime/node-v*-linux-x64.tar.xz -C /opt/node --strip-components=1 || fail "Node.js не распаковался"
  # nova.service starts /usr/bin/node.
  for b in node npm npx; do ln -sf "/opt/node/bin/$b" "/usr/bin/$b"; done
fi
echo "  node $(node -v)"
if ! command -v livekit-server >/dev/null; then
  say "LiveKit"
  tar -xzf "$USB"/runtime/livekit_*_linux_amd64.tar.gz -C /usr/local/bin livekit-server || fail "LiveKit не распаковался"
  chmod 755 /usr/local/bin/livekit-server
fi
echo "  livekit $(livekit-server --version 2>/dev/null | awk '{print $NF}')"

# ── the server ───────────────────────────────────────────────────────────────
say "сервер: пакеты Ubuntu, сборка, база, nginx, LiveKit (10–20 минут)"
rm -rf "$SRC" && mkdir -p "$SRC"
tar -xzf "$USB/src.tar.gz" -C "$SRC" || fail "исходники на флешке повреждены"
(cd "$SRC" && bash deploy/setup.sh) || fail "deploy/setup.sh завершился с ошибкой (подробности выше)"

# ── done: HTTPS keeps being tried until the router forwards the ports ────────
install -m 644 "$USB/nova-https.service" "$USB/nova-https.timer" /etc/systemd/system/
systemctl daemon-reload
. /etc/nova/nova.env
if [ -d "/etc/letsencrypt/live/${PUBLIC_URL#https://}" ]; then
  systemctl disable -q --now nova-https.timer 2>/dev/null || true
else
  systemctl enable -q --now nova-https.timer
fi
systemctl disable -q nova-firstboot.service
touch "$USB/.installed"
say "готово"
bash "$USB/nova-status.sh"
