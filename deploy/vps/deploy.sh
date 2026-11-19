#!/usr/bin/env bash
# One-shot deploy / update for a single Debian/Ubuntu VPS. Safe to run again
# for every update: it pulls the latest code, rebuilds, and runs database
# migrations automatically as the backend starts.
#   cd /opt/safestores && bash deploy/vps/deploy.sh
set -euo pipefail
DIR=/opt/safestores
DOMAIN=safestores.name.ng
APP_DOMAIN=app.safestores.name.ng
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

echo "== 3. Settings (.env)"
if [ ! -f .env ]; then
  read -rp "   Super Admin email (your login for the platform admin): " SA_EMAIL
  SA_PASS=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)
  cat > .env <<ENV
POSTGRES_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -hex 48)
FRONTEND_URL=https://$APP_DOMAIN
FRONTEND_BIND=127.0.0.1:8080
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
fi

echo "== 4. Building and starting (database migrations run automatically)"
docker compose up -d --build --remove-orphans
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8080/api/settings/currency >/dev/null 2>&1; then echo "   app is up"; break; fi
  sleep 4
  [ "$i" = 30 ] && { echo "   app did not come up; last backend logs:"; docker compose logs --tail=60 backend; exit 1; }
done
docker compose logs backend 2>&1 | grep -iE "migrat|applied" | tail -5 || true

echo "== 5. Web server (nginx)"
SITE=/etc/nginx/sites-available/safestores
if [ -e /etc/nginx/sites-enabled/safestores ] && [ ! -e /root/nginx-safestores.before-deploy ]; then
  cp -L /etc/nginx/sites-enabled/safestores /root/nginx-safestores.before-deploy
  echo "   old nginx config saved in /root/nginx-safestores.before-deploy"
fi
if ! grep -q "$APP_DOMAIN" "$SITE" 2>/dev/null; then
  cp deploy/vps/nginx-safestores.conf "$SITE"
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

echo
echo "Done. Landing page: https://$DOMAIN   App: https://$APP_DOMAIN"
