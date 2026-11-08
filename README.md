# SAFE Stores — Enterprise Inventory Management System

**A product of A I Brains Ventures.**

Two editions live in this repo:

- **`backend/` + `frontend/`** — the web app edition: Node/Express API +
  PostgreSQL + a React frontend you deploy to a server and access via browser.
- **`desktop/`** — the desktop app edition: the same features packaged as a
  real Windows/Mac/Linux installer (Electron + embedded SQLite), with a
  desktop shortcut, one-time in-app setup wizard, and fully offline operation.
  See **[`desktop/README.md`](./desktop/README.md)** for build instructions.

The rest of this file covers the web app edition.

**Want to deploy this right now?** See
[`DEPLOY_RAILWAY_RENDER.md`](./DEPLOY_RAILWAY_RENDER.md) for copy-paste
steps to get it live on GitHub + Railway/Render. For deeper background
(Docker, a self-hosted VPS, secrets management), see
[`DEPLOYMENT.md`](./DEPLOYMENT.md).

---

A full multi-tenant inventory management system: Node.js/Express REST API,
PostgreSQL database, and a React (Vite) frontend. Replaces the earlier
single-HTML-file prototypes with a real, deployable client/server app.

```
safe-stores/
├── backend/     Express API + PostgreSQL
└── frontend/    React (Vite) SPA
```

## 1. Prerequisites

- Node.js 18+ and npm
- PostgreSQL 14+ (local install, or a hosted instance — Supabase, Neon, Railway, RDS, etc.)

## 2. Backend setup

```bash
cd backend
npm install
cp .env.example .env
```

Edit `.env`:
- `DATABASE_URL` — your Postgres connection string
- `JWT_SECRET` — any long random string
- `BOOTSTRAP_SUPER_ADMIN_EMAIL` / `BOOTSTRAP_SUPER_ADMIN_PASSWORD` — credentials for the
  first Super Admin account, auto-created the first time the server starts

Create the database (if it doesn't exist yet), then run the schema:

```bash
createdb safestores          # or create it via your Postgres provider's dashboard
npm run migrate               # applies migrations/schema.sql
npm run seed                  # OPTIONAL: creates a demo store + admin + sample products
npm run dev                    # starts the API on http://localhost:4000
```

On first startup the server automatically creates your Super Admin account from
the `.env` values (only if no super admin exists yet).

If you ran `npm run seed`, you can also log in immediately as a demo store admin:
`admin@demo.com` / `Demo123!`.

## 3. Frontend setup

```bash
cd frontend
npm install
npm run dev                    # starts the app on http://localhost:5173
```

The Vite dev server proxies `/api` and `/uploads` requests to `http://localhost:4000`,
so no extra configuration is needed for local development.

## 4. First-run walkthrough

1. Go to `http://localhost:5173/super-login` and sign in with your bootstrapped
   Super Admin credentials.
2. Under **Subscriptions**, generate an access code for whichever plan you want to test.
3. Log out, go to `/signup`, and register a new store (pick any plan — it starts `pending`).
4. Log in immediately at `/login` with the new admin's email/password — pending
   admins CAN log in (just not other roles), and you'll land on an **Activate
   Your Store** screen. Enter the access code from step 2 to activate it.
   (Alternatively, a Super Admin can activate any store directly from
   **Manage Stores** without a code — both paths work.)
5. You're now in the full dashboard: add products, record stock arrivals,
   create invites, run shelf audits, view analytics, export data, etc.
6. Test invite-code login: create an invite from the Invites screen, then
   either paste the code into the "Invite Login" tab, or click the shared
   link (`/login?invite=CODE`) — it pre-fills and switches tabs automatically.

## 5. Deploying

- **Backend**: any Node host (Render, Railway, Fly.io, a VPS with PM2, etc.).
  Point `DATABASE_URL` at your production Postgres and set a strong `JWT_SECRET`.
  The API and the realtime (Socket.IO) layer share one HTTP server/port — no
  separate service to deploy.
- **Frontend**: `npm run build` produces a static `dist/` folder deployable to
  Vercel, Netlify, Cloudflare Pages, or served by any static file host / the
  backend itself via `express.static`.
- Set `FRONTEND_URL` in the backend `.env` to your deployed frontend origin (for CORS
  *and* the Socket.IO handshake, which uses the same origin check).
- Set `VITE_API_URL` in the frontend `.env` to your deployed backend's base URL
  if frontend and backend aren't on the same origin/proxy setup — the realtime
  connection derives its own origin from this automatically.
- **Reverse proxy / load balancer**: if you put Nginx, Caddy, or a cloud LB in
  front of the backend, make sure it forwards WebSocket upgrade requests
  (`Connection: Upgrade`, `Upgrade: websocket`) for the `/socket.io` path —
  this is what real-time multi-user sync rides on. If you scale the backend
  to multiple instances, either enable sticky sessions on the load balancer
  or add the `socket.io-redis` adapter so events broadcast across instances.
- **OCR**: Tesseract.js downloads its English language model from a CDN the
  first time it runs, so the backend host needs outbound internet access at
  least once (or set `TESSDATA_PATH` to a pre-downloaded copy for air-gapped
  hosts — see `backend/.env.example`).
- **Camera/barcode scanning**: browsers only allow camera access
  (`getUserMedia`) on `https://` or `localhost` — plan for TLS on your
  deployed frontend domain, not just the backend.
- **Production hardening**: set `NODE_ENV=production`. The server then
  refuses to start unless `JWT_SECRET` and `FRONTEND_URL` are properly set
  (see `src/config/validateEnv.js`), enables `helmet` security headers,
  rate-limits auth endpoints (20 attempts/15min) and the general API
  (600 req/15min per IP), and enables SSL on the Postgres connection. Set
  `DATABASE_SSL=require` explicitly if your provider needs it outside of
  `NODE_ENV=production` (see `.env.example`).
- **Uploaded receipt/camera images**: durable by default now — set
  `S3_BUCKET` (+ credentials) in `.env` and uploads go straight to
  S3-compatible object storage (AWS S3, Cloudflare R2, Backblaze B2,
  DigitalOcean Spaces, MinIO — see `src/utils/storage.js` and
  `.env.example`). Without `S3_BUCKET` set it falls back to local disk
  (`backend/uploads/`) for local dev — the server logs a startup warning
  in that case, since most PaaS hosts (Render, Railway, Fly) use an
  **ephemeral filesystem** and local-disk uploads will disappear on the
  next redeploy or restart unless you also attach a persistent volume.

### Backend deployment: traditional vs. serverless (optional)

Everything above describes the traditional path (`backend/server.js`, an
always-on Node process). That's fully supported and is what you want if
you need the realtime layer working. There's also a second, equally
supported option if you'd rather run this as Netlify Functions against
Supabase (or any other Postgres) instead of managing a persistent server:

- `backend/netlify.toml` + `backend/netlify/functions/` wrap the exact
  same Express app (`src/app.js`) with `serverless-http` — every route
  behaves identically either way. Deploy the `backend/` folder as its own
  Netlify site, point the frontend's `VITE_API_URL` at that site's URL.
- **What's different under serverless**: no realtime (Socket.IO can't run
  in a stateless function — the frontend already degrades gracefully when
  it can't connect), no in-process billing loop (there's a
  `netlify/functions/billing-cron.js` Scheduled Function instead), and
  `bootstrapSuperAdmin()` doesn't run on startup the way it does in
  `server.js` — call `POST /api/setup/super-admin` once yourself after
  your first deploy (same self-locking endpoint either way).
- **Database**: any Postgres works, including Supabase's own — this
  codebase never uses named prepared statements, so it's already
  compatible with Supabase's transaction-mode connection pooler (port
  6543), which you should use instead of the direct connection (port
  5432) for a serverless deployment. Keep `DB_POOL_MAX` low (1–2) here —
  see `.env.example` for why.
- **File uploads**: `S3_BUCKET` isn't just recommended here, it's
  required — there's no persistent disk at all between function
  invocations on Netlify, not even within one deploy.

Pick whichever fits how you want to operate this; neither is the "real" one.

## 6. What's implemented

**New in this revision** (all verified against a real database, see the
inline comments in `src/jobs/billingJob.js` and `src/controllers/` for the
exact behavior):
- **Store tiers**: Super Admin assigns Mini/Midi/Mega to each store at
  activation (not chosen by the store at signup), driving product/user
  limits via `store_tiers`.
- **Usage-based billing**: each store is either on `daily_percentage`
  (charged a configurable % — 1% by default — of that day's real
  transaction revenue, across POS + fulfilled marketplace orders) or
  `custom` (a manually negotiated arrangement, notes only). An unpaid
  daily charge triggers a realtime warning, then locks the store
  (`402` on every route except billing status) `grace_period_minutes`
  later — a Super Admin marking the charge paid unlocks it immediately.
  Actually collecting the money is a manual "mark paid" action for now;
  wire a real payment gateway's webhook to call the same endpoint to
  automate it (see the comment atop `billingJob.js`).
- **POS checkout/cashier**: a `checkout` role scans (live barcode/QR via
  the camera, same as the Camera page), searches, or manually adds items
  to a pending order — each addition deducts stock immediately via the
  same event-sourced movement log as everything else. A `cashier` (or
  admin/manager) confirms payment and a receipt number is issued. Split
  vs. merged checkout is just which roles a store invites — `checkout`
  can never mark an order paid, `cashier` can do both, so a "merged"
  store simply never invites anyone as `checkout`.
- **Auditor marketplace**: shelf audits are no longer a standing admin
  feature. A Super Admin activates independent auditor accounts; a store
  admin requests an audit any time from the Auditor tab; once an active
  auditor accepts, shelf-audit access opens for that store until the
  engagement is completed, and the auditor invites their own
  stock-takers (scoped to that engagement) rather than the store admin
  managing that team directly.
- **Online marketplace**: a public storefront per store (`/shop/:storeId`)
  where customers sign up, browse, and place orders from home; the admin
  sees and fulfills them from the Marketplace tab, deducting stock the
  same way a POS sale does.
- **Versioned migrations**: `migrations/NNN_description.sql` + a runner
  that tracks what's applied in `schema_migrations` — adding a new
  feature is a new numbered file, never an edit to what's already
  deployed, so upgrading a live store never risks its existing data.
- **Support tickets**: replaces "support is an email address" with a real
  in-app queue (`support_tickets`/`support_ticket_replies`). Store
  admins/managers raise a ticket and reply under Support; a Super Admin
  sees every store's tickets in one place under Support Tickets and
  replies. Set `SMTP_HOST`/`SUPPORT_INBOX_EMAIL` in `.env` to also get
  an email copy of new tickets/replies (via `src/utils/mailer.js`) — the
  in-app thread works fully either way.
- **Integrations (outbound webhooks)**: a store admin registers a URL +
  which events matter (receipt applied, order paid, purchase order
  auto-created, etc.) under Integrations, and gets an HMAC-signed POST
  when they happen (`src/utils/webhooks.js`). This is the generic
  "connect anything" answer — Zapier, Make, a Google Sheets script, or
  in-house software can all subscribe without a bespoke integration
  built for each one.
- **Supplier Performance Analytics**: a normalized `suppliers` table
  (backfilled automatically from whatever free-text supplier names were
  already in use — see `014_supplier_performance.sql`) tracks on-time
  delivery rate (expected delivery = PO sent date + that order's average
  product lead time, compared against when it was actually received),
  total spend, and order history per supplier — all computed from real
  purchase-order data, nothing manually entered. It also flags when a
  product has a cheaper known supplier than the one it's currently
  costed against, both on each supplier's own performance page and as a
  store-wide "Better Pricing Available" list under Suppliers.

Fully implemented, working end-to-end against the real database:
- Three-tier auth (Super Admin / Store Admin / Invite-code login), JWT sessions
- Store registration → Super Admin activation (assigns tier + billing) →
  store management
- Bulk invite creation (comma-separated names → auto emails → codes),
  single invites, revocation
- Full product CRUD with computed selling price & stock value
- Stock arrivals, stock movements (transfer/sale/damage/expiry/adjustment),
  shelf audits with auto-adjust
- **Receipt scanning**: upload a photo → real OCR (Tesseract.js, runs locally,
  no API key) extracts line items → review screen → one-time apply-to-stock,
  matching existing products by name/SKU or creating new ones automatically
- **Barcode/QR scanning**: the Camera page decodes UPC/EAN/Code128/QR/etc.
  directly from the live video feed (ZXing) and looks the code up against
  product SKUs automatically, with manual entry as a fallback for damaged codes
- **Realtime multi-user sync**: every user connected to the same store
  (any role) sees stock arrivals, movements, shelf audits, receipt actions,
  product changes, and camera captures from teammates the instant they
  happen — no manual refresh, via Socket.IO. A live/offline indicator and
  "N other online" count show in the sidebar.
- **Anti-duplication for simultaneous stock-taking**: products can carry a
  free-text `location` (e.g. "Aisle 3, Shelf B, Ground Floor"). Shelf Audit
  lets a stock-taker filter the product list to one location so a team can
  split the floor instead of everyone working off the same list, plus two
  live signals — a "someone is counting this right now" flag, and an
  "already counted today, by whom" indicator — for when lists do overlap.
- **Event-sourced stock quantities**: `shelf_qty`/`backroom_qty`/etc. are
  never incremented in place — they're recomputed from a pure SUM over the
  append-only `stock_movements` log every time (see `stockMath.js`). This is
  what makes merging data from multiple offline devices safe: a SUM over
  UUID-keyed rows is correct no matter what order the rows arrive in.
- **Idempotent writes**: arrivals/movements/audits/products accept an
  optional client-generated `id`. Replaying the exact same request (a retry
  after a dropped connection, or the same action reaching the server via
  two different sync paths) is a safe no-op — `ON CONFLICT (id) DO NOTHING`
  — instead of a duplicate/double-count.
- **Offline-capable web client**: writes to the core stock-taking endpoints
  made with no connection are queued in IndexedDB (`frontend/src/offline/`)
  and shown to the user immediately as "queued — will sync"; they replay
  automatically, in order, the moment connectivity returns (checked on the
  `online` browser event and a background interval). Reads fall back to the
  last-cached copy of each screen when there's no connection at all.
- **Store-to-store/device sync** (`/sync/export`, `/sync/import`, both
  authenticated with a per-store shared `sync_key` rather than a per-user
  login): any device can pull what's changed elsewhere since its last sync
  and push what changed locally, and it's safe to run in any order or
  redundantly — see stockMath.js's recompute step and the idempotent ids
  above.
- **LAN relay for the desktop edition**: the Electron app broadcasts and
  discovers other installs for the same store on the local network (UDP,
  no internet required — see `desktop/server/lan.js`) and syncs directly
  with them via the endpoints above, then separately syncs with the cloud
  whenever internet is available (`desktop/server/syncAgent.js`). No
  dedicated "hub" device is required — any two installs for the same store
  find each other automatically.
- **Production hardening**: `helmet`, response compression, a strict CORS
  allowlist (shared identically between REST and the realtime layer),
  rate limiting (tighter on auth endpoints), fail-fast environment
  validation (refuses to boot in production with a placeholder JWT secret
  or missing CORS origin), a configurable DB connection pool size, and
  graceful shutdown that drains the pool before exiting.
- Analytics dashboard backed by real SQL aggregation (Chart.js visuals)
- CSV exports (products/movements/audits/full) and full JSON backup
- Multi-channel invite sharing (WhatsApp/SMS/email deep links, native share, copy)

Implemented as a deliberate stub (needs a paid vendor account to change):
- **SMS/WhatsApp delivery** — these open the browser's native share sheet /
  `wa.me` / `sms:` links with a pre-filled message rather than sending via a
  paid API (Twilio, WhatsApp Business API) — wire those in if you need
  server-sent messages instead of user-initiated ones.
- **Cycle Counting & Inventory Accuracy**: now full parity across both
  editions — Web/LAN Edition (Postgres, `src/jobs/cycleCountJob.js` +
  `netlify/functions/cycle-count-cron.js`) and Desktop Edition (SQLite,
  `desktop/server/cycleCountJob.js`) run the identical risk-scoring logic
  (`utils/cycleCounting.js` is pure JS, shared unchanged between them):
  value at stake, recent discrepancy history, and staleness rank which
  products get a spot-check task each day, capped at 5 new tasks/store/day
  so it's a manageable daily list, not a flood.
- **Referral tracking**: store signup (self-serve web signup, and Super
  Admin directly registering a store) captures an optional marketer/
  affiliate email or phone number. Super Admin's Referrals page groups
  stores by referrer with active/pending/suspended counts, so a bonus
  decision is based on real paying customers, not raw signups.
- **Perishable goods (storage_type)**: a product can be marked `ambient`
  (default, unchanged behavior), `refrigerated`, or `frozen`. Refrigerated/
  frozen goods — fresh dairy, produce, ice cream — use a much tighter
  expiry-urgency curve than shelf-stable packaged goods: the discount
  bands trigger at day counts roughly a third of ambient's, and the daily
  alert sweep only looks 10 days out instead of 30, so genuinely urgent
  perishables aren't buried among far-out ambient items. A single
  refrigerated/frozen item within 2 days of expiry escalates the whole
  alert's severity, even if it's the only urgent item that day.
- **Multi-currency**: confirmed working — a single store-wide currency
  (code + symbol, from a curated list in `src/utils/currency.js`) is set
  by Super Admin and applied everywhere money is displayed via
  `useCurrency()`/`formatCurrency()`, including the public storefront for
  logged-out visitors.
- **Multi-language: implemented.** react-i18next with 8 languages —
  English, Français, Hausa, Yorùbá, Igbo, Kiswahili, العربية (full RTL
  layout mirroring) and 中文 — in `frontend/src/i18n/`. Every page uses
  `t()`; the switcher sits in the sidebar and the choice is remembered per
  device (`ss_lang` in localStorage), never auto-detected from the browser.
  Adding a language = one new `locales/<code>.json` + one line in
  `SUPPORTED_LANGUAGES`. Translations are machine-quality: have a native
  speaker review ha/yo/ig/sw/ar/zh before marketing in those languages.

Known gaps, worth knowing before a large-scale launch:
- **Translation review**: the 7 non-English locales need a native-speaker
  pass before launch in those markets (see above).
- **Mobile/desktop app-store packaging** hasn't been built yet — today this
  ships as a responsive web app plus an Electron desktop installer (NSIS/DMG/
  AppImage, direct download, not yet in Store format). Getting into the
  Microsoft Store, Mac App Store, Apple App Store, and Google Play each
  needs additional packaging work (MSIX/`mas` targets, a Capacitor mobile
  wrapper, developer accounts, code signing, and each store's own review).
- **Dependency security** (`npm audit`, checked directly against each
  package, not assumed): `backend` is at **0 vulnerabilities** (upgraded
  `multer` 1.x→2.x, `nodemailer` 6.x→9.x for several SMTP-injection/SSRF
  CVEs, and forced a patched `uuid` via `overrides` since `firebase-admin`
  bundles a vulnerable one transitively regardless of which submodule you
  actually use). `frontend` is down to one advisory in `react-router-dom`
  affecting its RSC (React Server Components) mode — irrelevant here since
  this is a plain client-side SPA that never uses RSC, but flagging it
  rather than claiming a false zero. `desktop`'s runtime is clean;
  `electron-builder` was upgraded (24.x→26.x) which cleared a critical/high
  `tar` chain, but `electron` itself has one open advisory requiring a
  31→43 major-version jump too large to upgrade blind without real
  Windows/Mac/Linux QA — a real follow-up, not done here. `mobile`'s
  Capacitor tooling (`@capacitor/assets`, `@capacitor/cli`) has several
  build-time-only advisories (`tar`/`sharp`/`minimatch`/`uuid`) with no fix
  available short of a full Capacitor major-version migration — none of
  this ships in the actual app binary, but it's real supply-chain exposure
  on the build machine worth revisiting.
- LAN discovery depends on UDP broadcast reaching every device — some
  Wi-Fi routers (guest networks, "client/AP isolation" mode) block that by
  default. If two devices on the same network aren't finding each other,
  that setting is the first thing to check.
- The full offline + LAN + cloud sync path has been verified with automated
  tests simulating multiple devices (including genuinely concurrent,
  independent offline edits converging correctly after sync), but not yet
  on real hardware over a real Wi-Fi network — that's a real-device QA pass
  worth doing before relying on it for a live multi-device store.

## 7. Tech stack

- **Backend**: Express, `pg` (raw SQL, no ORM — schema is in `migrations/schema.sql`),
  `bcryptjs`, `jsonwebtoken`, `multer` (file uploads), `socket.io` (realtime),
  `tesseract.js` (OCR)
- **Frontend**: React 18, React Router, Chart.js via `react-chartjs-2`, Axios,
  `socket.io-client` (realtime), `@zxing/browser` (barcode/QR scanning)
- **Database**: PostgreSQL
