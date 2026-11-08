# Pinned to match the Node version used in CI (.github/workflows/backend-ci.yml)
# so "passes CI" and "runs in this image" mean the same runtime.
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Uploads default to local disk (see server/utils/storage.js) — mount a
# volume here, or set S3_BUCKET (+ S3_* creds) in the environment instead,
# per the app's own startup warning when object storage isn't configured.
RUN mkdir -p /app/uploads
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Runs as a non-root user — standard container hardening, not something
# the app requires, but no reason not to.
RUN useradd --create-home --shell /bin/false appuser \
    && chown -R appuser:appuser /app
USER appuser

# Documents the default only — actual bind port follows $PORT if set
# (see server.js), which is how Railway/Render both assign ports.
EXPOSE 4000

# Reads PORT the same way server.js does (falls back to 4000) — hardcoding
# 4000 here would silently break on Railway/Render, which both inject
# their own PORT and expect the container to bind to it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 4000) + '/api/settings/currency', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Migrations run as a separate step (see docker-compose.yml / your
# deployment platform's release-phase hook), not baked into the image
# start command — running migrations on every container start/restart is
# unsafe with more than one replica.
CMD ["node", "server.js"]
