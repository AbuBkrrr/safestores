#!/usr/bin/env bash
# Points an existing Caddy reverse proxy (running in Docker) at this deploy:
#   safestores.name.ng, www  -> safestores-website (landing page)
#   app.safestores.name.ng   -> safestores-frontend-1 (the app)
# Backs up the Caddyfile, validates the new one, and restores it on error.
set -euo pipefail
CADDY=${1:?caddy container name}
DOMAIN=${2:-safestores.name.ng}
FILE=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}' "$CADDY")
[ -n "$FILE" ] || { echo "   could not find the Caddyfile of $CADDY"; exit 1; }
NET=$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' safestores-frontend-1 | awk '{print $1}')
docker network connect "$NET" "$CADDY" 2>/dev/null || true
BACKUP="$FILE.before-safestores-$(date +%Y%m%d%H%M%S)"
cp "$FILE" "$BACKUP"
python3 - "$FILE" "$DOMAIN" <<'PY'
import re, sys
path, dom = sys.argv[1], sys.argv[2]
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
if docker exec "$CADDY" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
  docker exec "$CADDY" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  echo "   Caddy now routes $DOMAIN and app.$DOMAIN to this deploy (backup: $BACKUP)"
else
  cp "$BACKUP" "$FILE"
  echo "   new Caddy config was invalid; restored the original"; docker exec "$CADDY" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile || true
  exit 1
fi
