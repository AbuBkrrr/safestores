# Deployment Guide

## What's here vs. what you still need to do

This repo now includes CI (GitHub Actions), Docker images for the cloud
backend and frontend, and a docker-compose stack that brings up a complete
staging environment (Postgres + backend + frontend) on a single machine.

**What this does NOT include, and can't from a development sandbox:**
a real cloud account, a domain, DNS, a TLS certificate, or a real secrets
manager. Those need your actual infrastructure decisions. This guide
covers how to plug this repo into whichever you choose.

The Docker images and compose file were written to standard patterns but
**not built or run** in the environment that produced them (no Docker
available there) — run `docker compose build` and confirm it succeeds
before relying on any of this.

---

## Quick start: staging on a single server

Any VPS (a $5-10/mo box from DigitalOcean, Hetzner, Linode, etc.) with
Docker and Docker Compose installed:

```bash
git clone <your-repo> && cd safe-stores-v22
cp .env.staging.example .env
# Edit .env: set POSTGRES_PASSWORD and JWT_SECRET (commands to generate
# both are in the file's comments). Set FRONTEND_URL to the address
# you'll actually reach this server at.
docker compose up --build -d
docker compose logs -f backend   # confirm migrations ran and it booted
```

The frontend is served on port 8080, proxying `/api`, `/uploads`, and
`/socket.io` straight through to the backend container — same relative-URL
setup as local dev, so nothing environment-specific is baked into the
frontend build.

Put this behind a reverse proxy (Caddy or nginx on the host, or your
cloud provider's load balancer) for TLS — the compose stack itself only
serves plain HTTP. Caddy is the simplest option if you're doing this
yourself: point a domain at the box and it handles Let's Encrypt
certificates automatically with about 4 lines of config.

## Managed platforms (Render, Railway, Fly, etc.)

The backend's `.env.example` already documents this path explicitly — it
was built with exactly this kind of deploy in mind:
- Point the platform at `backend/Dockerfile` (or let it auto-detect
  Node — both work, `.env.example` covers the traditional `server.js`
  path).
- Use the platform's managed Postgres, or point `DATABASE_URL` at Neon/
  Supabase/RDS.
- **Set `S3_BUCKET` (+ `S3_*` credentials)** — these platforms use
  ephemeral filesystems, so local-disk uploads (the default) will vanish
  on every redeploy. The backend prints a startup warning about this if
  you forget.
- Set `FRONTEND_URL` to your real frontend origin(s) — the server refuses
  to start in production without it.

The frontend is a static build (`frontend/Dockerfile`, or just `npm run
build` and serve `dist/` from any static host / CDN — Netlify, Vercel,
Cloudflare Pages, S3+CloudFront all work equally well since it's a plain
SPA).

## Secrets management

**Never commit a filled-in `.env` file** — `.gitignore` now blocks this,
but the discipline still matters more than the tooling.

- **GitHub Actions**: repo Settings → Secrets and variables → Actions.
  The CI workflows currently use inline test-only values (clearly not
  real secrets) — for a future deploy-on-merge workflow, add real
  secrets here and reference them as `${{ secrets.NAME }}`.
- **A VPS running docker-compose**: the `.env` file next to
  `docker-compose.yml`, with the file itself never committed and
  permissions locked to the deploying user (`chmod 600 .env`).
- **A managed platform** (Render/Railway/Fly/Netlify): their built-in
  environment variable UI — all of them encrypt these at rest and none
  of them require a separate secrets manager for a project this size.
- **If you outgrow that**: a real secrets manager (AWS Secrets Manager,
  Doppler, 1Password Secrets Automation) becomes worth the setup cost
  once you have multiple services/environments sharing credentials —
  not necessary for a single-backend launch.

## Pre-launch checklist

- [ ] `JWT_SECRET` is a real generated value, not the placeholder
- [ ] `FRONTEND_URL` is set to your real domain(s)
- [ ] Object storage: `S3_BUCKET` set (or a genuinely persistent volume
      attached, if self-hosting with local disk)
- [ ] `SENTRY_DSN` set for both the backend and desktop editions, and the
      frontend's Sentry DSN configured — see error-monitoring setup
      (backend/src/utils/errorMonitoring.js)
- [ ] Database backed up on a real schedule (managed Postgres providers
      handle this; a self-hosted box needs `pg_dump` on a cron)
- [ ] TLS is actually terminating somewhere (reverse proxy or platform)
      before this reaches real users — never serve real login credentials
      over plain HTTP
- [ ] The bootstrap super-admin password
      (`BOOTSTRAP_SUPER_ADMIN_PASSWORD`) has been changed from the
      `.env.example` default if it was ever left at that default
- [ ] i18n and error monitoring are wired up (see project notes — these
      were flagged as launch requirements)
- [ ] If the desktop edition has already been distributed to any real
      user before this session's billing-table fix, plan the SQLite
      migration for their existing local database (see desktop test
      notes — the fix only applies to fresh installs)
