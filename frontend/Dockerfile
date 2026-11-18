# Pinned to match CI (.github/workflows/frontend-ci.yml).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Optional build-time override — leave unset for the standard same-origin
# deployment (nginx.conf below reverse-proxies /api,/uploads,/socket.io to
# the backend, exactly like vite.config.js's dev proxy does). Only pass
# this if the frontend is served from a different origin than the API.
ARG VITE_API_URL
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost/ >/dev/null || exit 1
