#!/usr/bin/env bash
# One-shot deploy / update for a single Debian/Ubuntu VPS. Safe to run again
# for every update: it pulls the latest code, rebuilds, and runs database
# migrations automatically as the backend starts.
#   cd /opt/safestores && bash deploy/vps/deploy.sh
set -euo pipefail
DIR=/opt/safestores
DOMAIN=safestore.com.ng
APP_DOMAIN=app.safestore.com.ng
cd "$DIR"

echo "== 1. Moving the old hand-made landing-page files out of the way"
if [ -f nginx.conf ] && ! git ls-files --error-unmatch nginx.conf >/dev/null 2>&1; then
  docker compose down --remove-orphans 2>/dev/null || true
  OLD=/root/safestores-old-site-$(date +%Y%m%d%H%M%S)
  mkdir -p "$OLD"
  for f in Dockerfile app docker-compose.yml nginx.conf; do
    if [ -e "$f" ] && ! git ls-files --error-unmatch "$f" >/dev/null 2>&1; then mv "$f" "$OLD/"; fi
  done
  echo "   saved in $OLD"
fi

echo "== 2. Getting the latest code"
git fetch origin main
git checkout -q main
git merge --ff-only origin/main

# First free local port from 8080 up (another site on this server may hold 8080).
port_busy() { ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q .; }
free_port() { for p in $(seq 8080 8099); do port_busy "$p" || { echo "$p"; return; }; done; echo 8099; }

echo "== 3. Settings (.env)"
if [ ! -f .env ]; then
  read -rp "   Super Admin email (your login for the platform admin): " SA_EMAIL
  SA_PASS=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)
  cat > .env <<ENV
POSTGRES_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -hex 48)
FRONTEND_URL=https://$APP_DOMAIN
FRONTEND_BIND=127.0.0.1:$(free_port)
BACKEND_REPLICAS=1
BOOTSTRAP_SUPER_ADMIN_NAME=Super Admin
BOOTSTRAP_SUPER_ADMIN_EMAIL=$SA_EMAIL
BOOTSTRAP_SUPER_ADMIN_PASSWORD=$SA_PASS
SUPPORT_INBOX_EMAIL=support@$DOMAIN
ENV
  chmod 600 .env
  echo "   Created .env. Super Admin password (write it down, then change it after first login): $SA_PASS"
else
  echo "   Keeping the existing .env"
  # Moving to a new domain: the app accepts both addresses, links use the new one.
  if ! grep -q "^FRONTEND_URL=.*$APP_DOMAIN" .env; then
    OLD=$(grep '^FRONTEND_URL=' .env | cut -d= -f2-)
    sed -i '/^FRONTEND_URL=/d' .env
    echo "FRONTEND_URL=https://$APP_DOMAIN${OLD:+,$OLD}" >> .env
    echo "   Added https://$APP_DOMAIN to FRONTEND_URL (kept: ${OLD:-none})"
  fi
  grep -q '^PUBLIC_APP_URL=' .env || echo "PUBLIC_APP_URL=https://$APP_DOMAIN" >> .env
  grep -q '^MARKETING_LANDING_URL=' .env || echo "MARKETING_LANDING_URL=https://$DOMAIN" >> .env
fi

# Our app port: keep it unless another program has taken it.
PORT=$(grep -E '^FRONTEND_BIND=' .env | sed -E 's/.*:([0-9]+)$/\1/'); PORT=${PORT:-8080}
if port_busy "$PORT" && ! docker compose ps --status running frontend 2>/dev/null | grep -q frontend; then
  PORT=$(free_port)
  if grep -q '^FRONTEND_BIND=' .env; then sed -i "s/^FRONTEND_BIND=.*/FRONTEND_BIND=127.0.0.1:$PORT/" .env; else echo "FRONTEND_BIND=127.0.0.1:$PORT" >> .env; fi
  echo "   port in use by another program; the app will use port $PORT"
fi

echo "== 4. Building and starting (database migrations run automatically)"
docker compose up -d --build --remove-orphans
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/settings/currency" >/dev/null 2>&1; then echo "   app is up"; break; fi
  sleep 4
  [ "$i" = 30 ] && { echo "   app did not come up; last backend logs:"; docker compose logs --tail=60 backend; exit 1; }
done
docker compose logs backend 2>&1 | grep -iE "migrat|applied" | tail -5 || true

# Who answers on port 80/443: a Caddy container (shared with other sites) or host nginx.
CADDY=$(docker ps --format '{{.Names}} {{.Image}} {{.Ports}}' | awk '$2 ~ /^caddy/ && /:443->/ {print $1; exit}')
if [ -n "$CADDY" ]; then
  echo "== 5. Web server: routing through the Caddy container $CADDY"
  bash deploy/vps/caddy-route.sh "$CADDY" "$DOMAIN"
  echo "   (Caddy gets the HTTPS certificates itself)"
else
  echo "== 5. Web server (nginx)"
  SITE=/etc/nginx/sites-available/safestores
  if [ -e /etc/nginx/sites-enabled/safestores ] && [ ! -e /root/nginx-safestores.before-deploy ]; then
    cp -L /etc/nginx/sites-enabled/safestores /root/nginx-safestores.before-deploy
    echo "   old nginx config saved in /root/nginx-safestores.before-deploy"
  fi
  if ! grep -q "$APP_DOMAIN" "$SITE" 2>/dev/null || ! grep -q "127.0.0.1:$PORT;" "$SITE"; then
    sed "s/127.0.0.1:8080/127.0.0.1:$PORT/" deploy/vps/nginx-safestores.conf > "$SITE"
    ln -sf "$SITE" /etc/nginx/sites-enabled/safestores
  fi
  nginx -t && systemctl reload nginx

  echo "== 6. HTTPS certificates"
  command -v certbot >/dev/null || apt-get install -y certbot python3-certbot-nginx
  DOMAINS="-d $DOMAIN"
  for d in "www.$DOMAIN" "$APP_DOMAIN"; do getent hosts "$d" >/dev/null && DOMAINS="$DOMAINS -d $d"; done
  certbot --nginx --non-interactive --agree-tos --redirect --expand -m "support@$DOMAIN" $DOMAINS || echo "   certbot failed; see the message above"
  if ! getent hosts "$APP_DOMAIN" >/dev/null; then
    echo "   !! $APP_DOMAIN has no DNS record yet. Add an A record: app -> $(curl -fsS -4 ifconfig.me 2>/dev/null || echo the server IP)"
    echo "      then run this script again to get its certificate."
  fi
fi

echo
echo "Done. Landing page: https://$DOMAIN   App: https://$APP_DOMAIN"
