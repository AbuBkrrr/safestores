# SAFE Stores — Step by Step, Zip to Full Operation

This is the ONE ordered path. Every step links to the doc with full
detail; this file's job is the *sequence* and what's genuinely still
open. Do the sections in order — later steps assume earlier ones are done.

**Status check first, so nothing here is a surprise:**
- ✅ Backend, desktop, frontend — built, tested (458 tests), Docker-verified
- ✅ Error monitoring (Sentry) — wired, just needs a DSN (Step 4)
- ✅ Payment — manual bank transfer, working; gateway integration is a placeholder (Step 8)
- ✅ Download page — built, needs real links wired in (Step 9)
- ✅ Multi-language (i18n) — 8 languages incl. Arabic RTL; needs native-speaker review (Step 11)
- ❌ Mobile app — code complete, not signed, not published (Step 7)
- ❌ Real hosting/domain live — not deployed anywhere yet (Step 3)

---

## Step 0 — Accounts you need before starting

Get these first; several steps below stall without them.

| Account | For | Cost |
|---|---|---|
| A hosting provider (Render/Railway/Fly.io, or any VPS) | Running the backend | Varies, ~$5-25/mo to start |
| A Postgres provider (or use the hosting provider's managed one) | The database | Often bundled with hosting |
| Domain registrar access for `safestores.name.ng` | Pointing DNS at your host | Already registered per your note |
| Sentry (sentry.io, free tier) | Error monitoring | Free |
| Firebase (console.firebase.google.com) | Android push notifications | Free |
| Google Play Console | Publishing the Android app | $25 one-time |
| A static host (Netlify/Vercel/Cloudflare Pages, or your own server) | Frontend + landing page | Often free tier |

---

## Step 1 — Local sanity check (5 minutes)

Before deploying anything, confirm the zip works on your machine.

```bash
cd backend && npm install && cp .env.example .env
# edit .env: set a real DATABASE_URL and a real JWT_SECRET
#   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
node src/db/migrate.js
npm test           # should show 198 passing
node server.js     # should boot without errors
```

If this doesn't pass cleanly, stop and fix it here — deploying a broken
build just moves the debugging to a place with less visibility.

---

## Step 2 — Database

Pick one:
- **Managed Postgres** (Render/Railway/Neon/Supabase) — easiest, handles
  backups automatically. Just copy the connection string into
  `DATABASE_URL`.
- **Self-hosted** (a VPS running Postgres, or the `docker-compose.yml`
  stack's `postgres` service) — you own backups. Set up `pg_dump` on a
  daily cron at minimum.

Either way, run migrations once against the real database before the
backend serves any traffic:
```bash
DATABASE_URL="<your real connection string>" node backend/src/db/migrate.js
```

---

## Step 3 — Backend deployment

Two paths — pick based on how hands-on you want to be. Full detail in
`DEPLOYMENT.md`.

**A) Managed platform (Render/Railway/Fly)** — point it at
`backend/Dockerfile`, or let the platform auto-detect Node. Set these
environment variables in the platform's dashboard:

```
NODE_ENV=production
DATABASE_URL=<from Step 2>
DATABASE_SSL=require          # unless self-hosting Postgres without TLS
JWT_SECRET=<generate, see Step 1>
JWT_EXPIRES_IN=7d
FRONTEND_URL=https://safestores.name.ng
S3_BUCKET=<see note below>
BOOTSTRAP_SUPER_ADMIN_EMAIL=super@safestores.name.ng
BOOTSTRAP_SUPER_ADMIN_PASSWORD=<a real password, not the .env.example default>
SENTRY_DSN=<from Step 4>
```

**Important:** managed platforms use ephemeral filesystems — set
`S3_BUCKET` (+ `S3_*` credentials) or uploaded receipt/product images
vanish on every redeploy. The backend prints a startup warning if you
forget this.

**B) Your own server (VPS + docker-compose)**
```bash
git clone <your repo> && cd safe-stores-v22
cp .env.staging.example .env
# fill in POSTGRES_PASSWORD, JWT_SECRET, FRONTEND_URL=https://safestores.name.ng
docker compose up --build -d
```
Put this behind Caddy or nginx on the host for TLS (a few lines of
config for a real Let's Encrypt cert). See `DEPLOYMENT.md`'s "Quick
start: staging on a single server" section for the exact setup.

**Verify it's really live:**
```bash
curl https://api.safestores.name.ng/api/settings/currency
# should return {"code":"NGN","symbol":"₦"}
```

---

## Step 4 — Error monitoring (5 minutes, do this before real users touch it)

1. Create a free project at sentry.io — one for "SAFE Stores Backend,"
   one for "SAFE Stores Frontend" (separate DSNs keep backend/frontend
   errors from mixing together).
2. Set `SENTRY_DSN` in the backend's environment (Step 3's list above).
3. Set `VITE_SENTRY_DSN` as a **build-time** variable when building the
   frontend (Step 5) — Vite bakes it into the bundle, it's not a runtime
   secret (a Sentry DSN is safe to ship publicly; it just identifies
   which project errors belong to).
4. Do the same for the desktop edition before packaging installers
   (Step 6) — set `SENTRY_DSN` as an environment variable during
   `npm run build:win/mac/linux`.

Confirm it's working: trigger a deliberate error (e.g. hit a nonexistent
route) and check it shows up in the Sentry dashboard within a minute.

---

## Step 5 — Frontend deployment

```bash
cd frontend
npm install
VITE_SENTRY_DSN=<from Step 4> npm run build
```
Deploy the `dist/` folder to any static host (Netlify, Vercel,
Cloudflare Pages) or serve it via the `frontend/Dockerfile` + nginx
setup (already wired to reverse-proxy `/api`, `/uploads`, `/socket.io`
to the backend — see `frontend/nginx.conf`).

Point `safestores.name.ng` (or a subdomain like `app.safestores.name.ng`)
at wherever this lands. Update `FRONTEND_URL` in the backend's
environment (Step 3) to match exactly, including protocol — the backend
refuses CORS requests from anything not listed there.

---

## Step 6 — Desktop installers

```bash
cd desktop
npm install     # runs electron-builder install-app-deps automatically
npm run prebuild
npm run build:win     # or build:mac / build:linux
```
Each must run on (or be cross-compiled for) its target OS — see
`desktop/README.md`. Output lands in `desktop/dist/`. Upload the
resulting installers somewhere stable (S3, your own server, GitHub
Releases) and update the "Request Installer" link in `website/index.html`
to point there directly.

---

## Step 7 — Mobile (Android)

Full detail in `mobile/README.md`. In order:
1. Install Android Studio.
2. Create the Firebase project (Step 0), add an Android app with package
   name `com.safestores.app`, download `google-services.json`, place it
   at `mobile/android/app/google-services.json`.
3. Get a Firebase service-account key for the *backend* side (Firebase
   Console → Project Settings → Service Accounts) — set it as
   `FIREBASE_SERVICE_ACCOUNT` in the backend's environment (Step 3).
   Until this is set, push notifications are a safe no-op.
4. Build pointed at your real deployed backend:
   ```bash
   cd mobile && npm install
   SAFE_STORES_API_URL=https://api.safestores.name.ng/api node scripts/build-www.js
   npx cap sync android
   ```
5. Generate a signing keystore **on your own machine, once, and back it
   up somewhere private** — exact commands in `mobile/README.md` step 6.
   Do not skip the backup: losing this key means you can never publish
   an update to the same app listing again.
6. `./gradlew bundleRelease` with your keystore → produces the `.aab`
   Google Play wants.
7. Google Play Console: create the listing, upload the `.aab`, submit
   for review (typically a few days).
8. Once approved, update the Android card in `website/index.html` from
   "Not Yet Published" to a real Play Store link.

---

## Step 8 — Payment: operational setup, not a code step

Direct bank transfer is already fully working — nothing to build. Log
in as Super Admin and:
1. Go to the payment settings screen (Subscriptions page).
2. Replace the default OPAY placeholder account details with your real
   bank/USSD/provider details — store admins see exactly what you enter
   here when they claim a payment.
3. Leave the "Payment Gateway (Coming Soon)" section alone for now — it's
   a deliberate placeholder for a future Paystack/Flutterwave/Stripe
   integration (see `GAPS_AND_DISCREPANCIES.md` §2), not something to
   configure yet.

---

## Step 9 — Publish the landing page

`website/index.html` is ready but has three placeholder links — see
`website/README.md` for exactly which ones and why. Once Steps 5-7 are
live, update:
1. "Open Web App" → your real Step 5 URL
2. "Request Installer" → wherever Step 6's installers are hosted
3. Android card → your real Play Store link once Step 7 is approved

Deploy this folder to the same static host as the frontend, or a
separate one — it's fully self-contained (no build step).

---

## Step 10 — Go-live smoke test

Before telling any real store about this, walk through it yourself
exactly as a new customer would:
1. Visit the landing page, click through to the web app.
2. Sign up a brand-new store (not the bootstrap Super Admin).
3. Confirm the store shows as "pending" and can't do much yet.
4. Log in as Super Admin, activate that store, assign a tier.
5. Log back in as the store admin, add a product, do a test sale at
   Checkout, confirm the receipt prints.
6. Claim a payment as that store, confirm it, and confirm the store
   unlocks/stays active.
7. Check Sentry — confirm zero unexpected errors logged during all of
   the above.

---

## Step 11 — Multi-language: built, needs a native-speaker check

Text-only translation (voice/TTS stays a later phase) is done:
English, Français, Hausa, Yorùbá, Igbo, Kiswahili, العربية (RTL) and 中文.
The switcher is in the sidebar; the choice is saved per device.

Before marketing in a non-English market:
1. Run the app: `cd frontend && npm run dev`
2. Pick the language in the sidebar switcher.
3. Have a native speaker click through Login, Checkout, Products and
   Dashboard and fix any wording directly in
   `frontend/src/i18n/locales/<code>.json` (same keys as `en.json`).

---

## Ongoing operations, once live

- **Backups**: confirm your Postgres provider actually runs them (most
  managed ones do by default) or that your `pg_dump` cron is really
  firing — check, don't assume.
- **Monitoring**: check Sentry weekly at minimum; the background jobs
  (billing, replenishment, expiry, cycle counting) run unattended and
  report failures there.
- **Support tickets**: come in through the in-app Support page, visible
  to Super Admin at `/super/support` — no separate email inbox needed
  unless you want one.
- **CI**: every push to `main` touching `backend/`, `desktop/`, or
  `frontend/` runs that edition's full test suite automatically (see
  `.github/workflows/`) — a red CI run means don't deploy that commit.
