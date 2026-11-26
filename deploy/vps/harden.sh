#!/usr/bin/env bash
# One-time server hardening for the SAFE Stores VPS (Debian/Ubuntu). Safe to
# run again. It never closes the SSH port you are using.
#   sudo bash /opt/safestores/deploy/vps/harden.sh
#
#  1. Firewall (ufw): only SSH, HTTP (80) and HTTPS (443) can reach the server.
#     The database and the app's internal ports stay closed to the internet
#     (they are also bound to the server itself in docker-compose.yml).
#  2. fail2ban: an address that keeps failing SSH logins is banned for 1 hour.
#  3. Automatic security updates for the operating system.
#  4. Checks: .env readable only by root, no database port open to the world.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "== 1. Firewall"
apt-get install -y -qq ufw >/dev/null
SSH_PORT=$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}'); SSH_PORT=${SSH_PORT:-22}
ufw allow "${SSH_PORT}/tcp" comment 'SSH' >/dev/null
ufw allow 80/tcp comment 'HTTP' >/dev/null
ufw allow 443/tcp comment 'HTTPS' >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw --force enable >/dev/null
echo "   open: SSH ${SSH_PORT}, 80, 443 — everything else closed"

echo "== 2. fail2ban (SSH password guessing)"
apt-get install -y -qq fail2ban >/dev/null
cat > /etc/fail2ban/jail.d/safestores.local <<JAIL
[sshd]
enabled = true
port = ${SSH_PORT}
maxretry = 5
findtime = 10m
bantime = 1h
JAIL
systemctl enable --now fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban >/dev/null 2>&1 || true
echo "   5 failed SSH logins in 10 minutes = banned for 1 hour"

echo "== 3. Automatic security updates"
apt-get install -y -qq unattended-upgrades >/dev/null
echo 'APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";' > /etc/apt/apt.conf.d/20auto-upgrades
echo "   on"

echo "== 4. Checks"
if [ -f /opt/safestores/.env ]; then chmod 600 /opt/safestores/.env; echo "   .env: readable only by root"; fi
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq '(^|[^0-9.])(0\.0\.0\.0|\*|\[::\]):5432$'; then
  echo "   WARNING: a database (port 5432) is open to the world — close it in its docker-compose file"
else
  echo "   database port 5432: not open to the internet"
fi
# Docker opens published ports itself, past the firewall: list any besides 80/443.
if command -v docker >/dev/null 2>&1; then
  OPEN=$(docker ps --format '{{.Names}} {{.Ports}}' | grep -Eo '[^ ]+ |0\.0\.0\.0:[0-9]+|\[::\]:[0-9]+' | tr '\n' ' ' | grep -Eo '(0\.0\.0\.0|\[::\]):[0-9]+' | grep -Ev ':(80|443)$' | sort -u | tr '\n' ' ' || true)
  if [ -n "$OPEN" ]; then echo "   WARNING: Docker containers open these ports to the internet (the firewall cannot block them): $OPEN"
    echo "            Bind them to 127.0.0.1 in their docker-compose file, or stop containers you no longer use."
  else echo "   Docker: only 80/443 open to the internet"; fi
fi
if grep -Eq '^\s*PasswordAuthentication\s+yes' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null; then
  echo "   Tip: SSH still accepts passwords. Once you log in with an SSH key, set 'PasswordAuthentication no'."
fi
echo "Done."
