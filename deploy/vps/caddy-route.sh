#!/usr/bin/env bash
# Points an existing Caddy reverse proxy (running in Docker) at this deploy:
#   safestore.com.ng, www  -> safestores-website (landing page)
#   app.safestore.com.ng   -> safestores-frontend-1 (the app)
# Backs up the Caddyfile, validates the new one, and restores it on error.
set -euo pipefail
CADDY=${1:?caddy container name}
DOMAIN=${2:-safestore.com.ng}
# Older addresses that keep working (space separated).
EXTRA_DOMAINS=${EXTRA_DOMAINS:-safestores.name.ng}
FILE=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}' "$CADDY")
[ -n "$FILE" ] || { echo "   could not find the Caddyfile of $CADDY"; exit 1; }
NET=$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' safestores-frontend-1 | awk '{print $1}')
docker network connect "$NET" "$CADDY" 2>/dev/null || true
BACKUP="$FILE.before-safestores-$(date +%Y%m%d%H%M%S)"
cp "$FILE" "$BACKUP"
# Old addresses forward people to the new one (pages only: installed apps keep
# talking to /api, /socket.io, /uploads on the old address). Only when the new
# address already points at this same server, so nobody is sent to a dead site.
REDIRECT=${REDIRECT_OLD:-auto}
if [ "$REDIRECT" = auto ]; then
  NEW_IP=$( (getent hosts "app.$DOMAIN" || true) | awk '{print $1; exit}')
  REDIRECT=0
  for D in $EXTRA_DOMAINS; do
    OLD_IP=$( (getent hosts "app.$D" || true) | awk '{print $1; exit}')
    [ -n "$NEW_IP" ] && [ "$NEW_IP" = "$OLD_IP" ] && REDIRECT=1
  done
  [ "$REDIRECT" = 1 ] && echo "   app.$DOMAIN points here: old addresses will forward to it" \
    || echo "   app.$DOMAIN does not point at this server yet: old addresses keep serving the app (no forwarding)"
fi
for D in $DOMAIN $EXTRA_DOMAINS; do
python3 - "$FILE" "$D" "$DOMAIN" "$REDIRECT" <<'PY'
import re, sys
path, dom, primary, redirect = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == '1'
text = open(path).read()
out, i, n = [], 0, len(text)
lines = text.split('\n')
res, skip, depth = [], False, 0
for line in lines:
    if not skip and depth == 0 and line.strip().endswith('{'):
        sites = [s.strip().strip(',') for s in line.strip()[:-1].replace(',', ' ').split()]
        if any(s in (dom, 'www.' + dom, 'app.' + dom) for s in sites):
            skip, depth = True, 1
            continue
    if skip:
        depth += line.count('{') - line.count('}')
        if depth <= 0:
            skip, depth = False, 0
        continue
    res.append(line)
old = redirect and dom != primary
if old:
    body = '\n'.join(res).rstrip() + f'''

{dom}, www.{dom} {{
	redir https://{primary}{{uri}} permanent
}}

app.{dom} {{
	encode gzip zstd
	request_body {{
		max_size 30MB
	}}
	@apps path /api/* /socket.io/* /uploads/* /go/* /share/* /sw.js /manifest.json /market.webmanifest
	handle @apps {{
		reverse_proxy safestores-frontend-1:80
	}}
	handle {{
		redir https://app.{primary}{{uri}} permanent
	}}
}}
'''
    open(path, 'w').write(body)
    sys.exit(0)
body = '\n'.join(res).rstrip() + f'''

{dom}, www.{dom} {{
	encode gzip zstd
	reverse_proxy safestores-website:80
}}

app.{dom} {{
	encode gzip zstd
	request_body {{
		max_size 30MB
	}}
	reverse_proxy safestores-frontend-1:80
}}
'''
open(path, 'w').write(body)
PY
done
if docker exec "$CADDY" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
  docker exec "$CADDY" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  echo "   Caddy now routes $DOMAIN, app.$DOMAIN (and $EXTRA_DOMAINS) to this deploy (backup: $BACKUP)"
else
  cp "$BACKUP" "$FILE"
  echo "   new Caddy config was invalid; restored the original"; docker exec "$CADDY" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile || true
  exit 1
fi
