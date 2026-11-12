# SAFE Stores — Launch Guide (v26)

The one ordered path from this repository to paying customers. Each step
says **what to do**, **where**, and **how to check it worked**. Do them in
order; later steps assume earlier ones.

> Older docs (`GO_LIVE.md`, `DEPLOYMENT.md`, `DEPLOY_RAILWAY_RENDER.md`)
> still hold useful detail; this guide supersedes their ordering.

---

## The shape of the deployment

| Address | What runs there | Where it's hosted |
|---|---|---|
| `safestores.name.ng` | Landing page (`website/`) | GitHub Pages (already wired: `.github/workflows/pages.yml`) |
| `app.safestores.name.ng` | The web app (`frontend/`) | Any static host (Render static site, Netlify, Cloudflare Pages) or the nginx container |
| `api.safestores.name.ng` | API + realtime + jobs (`backend/`) | Render / Railway / Fly, or a VPS with Docker |
| Postgres | Database | Managed Postgres (Render, Neon, Supabase, RDS) |
| Object storage | Product photos, receipt scans | S3-compatible bucket (Cloudflare R2, AWS S3, Backblaze B2) |
| Email | Password reset, verification, daily summary | Any SMTP provider (Resend, Postmark, SendGrid, Amazon SES, Brevo) |

If your domain changes, only environment variables change — nothing in
the code hard-codes it.

---

## Step 0 — Accounts to open first (≈1 hour)

| Account | Why | Cost |
|---|---|---|
| Hosting (e.g. Render) | Backend + frontend | Free to start; ~$7–25/month for always-on |
| Managed Postgres | Database with automatic backups | Free tier to start; ~$7–20/month in production |
| Object storage (e.g. Cloudflare R2) | Uploaded images survive redeploys | Free up to 10 GB |
| SMTP email provider | Password resets, verification, daily summaries | Free tiers cover thousands of emails/month |
| Domain DNS access | Point `app.` and `api.` subdomains | Already registered |
| Sentry (sentry.io) | Error alerts | Free |
| Paystack (optional) | Online payment of subscription charges | Per-transaction fees only |
| Google Play Console (Android) | Publish the app | $25 one-time |
| Windows code-signing certificate (desktop) | No "unknown publisher" warning | ~$100–400/year |
| Apple Developer (Mac desktop / iOS) | Signing + notarisation | $99/year |

None of these are software licences; the code itself needs none (see
"Licences" at the end).

---

## Step 1 — Merge the work (10 minutes)

1. Review and merge the pull request into `main`.
2. GitHub → **Actions**: the Backend, Frontend and Desktop CI workflows run
   on every push to `main`. All three must be green before you deploy.
3. GitHub → **Settings → Pages**: Source = **GitHub Actions**; Custom domain
   = `safestores.name.ng`; tick **Enforce HTTPS** once the certificate is
   issued. The workflow only publishes `website/`.

**Check:** `https://safestores.name.ng` shows the landing page.

---

## Step 2 — Local sanity check (15 minutes, optional but wise)

```bash
cd backend && npm ci && cp .env.example .env
# edit .env: DATABASE_URL to a local Postgres, a long JWT_SECRET, NODE_ENV=development
npm run migrate && npm run seed && npm run dev
```

```bash
cd frontend && npm ci && npm run dev
```

Open http://localhost:5173 and sign in as `admin@demo.com` / `Demo123!`.
Run `npm test` in `backend/`, `frontend/` and `desktop/`: all suites must pass.

---

## Step 3 — Database (15 minutes)

1. Create a managed Postgres 15+ database. Turn on automatic daily backups
   with point-in-time recovery if your plan offers it.
2. Copy its connection string; you'll set it as `DATABASE_URL`.

**Check:** you can connect with `psql "<connection string>"`.

Migrations run automatically when the backend starts (`node src/db/migrate.js`
is part of the start command). They're versioned and idempotent.

---

## Step 4 — Backend (30 minutes)

### Option A: Render Blueprint (simplest)

Render → **New → Blueprint** → choose this repo. `render.yaml` creates the
database, the backend and the frontend. Then edit the **backend** service's
environment:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | from Step 3 (set automatically by the blueprint) |
| `DATABASE_SSL` | `require` |
| `JWT_SECRET` | `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `JWT_EXPIRES_IN` | `7d` |
| `FRONTEND_URL` | `https://app.safestores.name.ng` (comma-separate extra origins) |
| `BOOTSTRAP_SUPER_ADMIN_EMAIL` | your email |
| `BOOTSTRAP_SUPER_ADMIN_PASSWORD` | a strong, unique password |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | from your email provider (Step 6) |
| `S3_BUCKET` / `S3_REGION` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_ENDPOINT` / `S3_PUBLIC_URL_BASE` | from Step 7 |
| `SENTRY_DSN` | from Sentry (backend project) |
| `PAYSTACK_SECRET_KEY` | optional (Step 10) |
| `FIREBASE_SERVICE_ACCOUNT` | optional, Android push (Step 13) |

### Option B: your own server (VPS + Docker)

```bash
git clone https://github.com/abubkrrr/safestores && cd safestores
cp .env.staging.example .env      # fill POSTGRES_PASSWORD, JWT_SECRET, FRONTEND_URL
docker compose up --build -d
```

Put Caddy in front for automatic HTTPS (`api.safestores.name.ng` →
`localhost:4000`, `app.safestores.name.ng` → `localhost:8080`). Add the
SMTP and S3 variables to the `backend` service in `docker-compose.yml`.
Schedule a nightly `pg_dump` off the server.

**Check:** `curl https://api.safestores.name.ng/api/health` returns
`{"status":"ok",…}`, and `https://api.safestores.name.ng/sitemap.xml` returns XML.

---

## Step 5 — Frontend (15 minutes)

Build-time variables (set them on the static site in your host):

| Variable | Value |
|---|---|
| `VITE_API_URL` | `https://api.safestores.name.ng/api` |
| `VITE_SENTRY_DSN` | Sentry (frontend project) |
| `VITE_LEGAL_ENTITY` | your registered business name |
| `VITE_LEGAL_CONTACT` | e.g. `support@safestores.name.ng` |
| `VITE_LEGAL_COUNTRY` | governing law, e.g. `the Federal Republic of Nigeria` |

Build command: `cd frontend && npm ci && npm run build`; publish `frontend/dist`.
Add a rewrite rule `/* → /index.html` (single-page app). `render.yaml` already
has one.

Make sure `/sw.js` and `/index.html` are served with `Cache-Control: no-cache`
(Render and Netlify do this by default; `frontend/nginx.conf` sets it).

**Check:** `https://app.safestores.name.ng/login` loads; DevTools → Application
shows the service worker active.

---

## Step 6 — Email (30 minutes) — required

Password reset, email verification and the daily summary depend on it.

1. Create an account with an SMTP provider and verify your domain.
2. Add the DNS records they give you: **SPF**, **DKIM**, and a **DMARC**
   record (`_dmarc` TXT, e.g. `v=DMARC1; p=quarantine; rua=mailto:you@…`).
   Without these, resets land in spam.
3. Set the `SMTP_*` variables on the backend (Step 4) and redeploy.

**Check:** on the login screen use **Forgot password?** for your own account;
the email arrives within a minute and the link works.

---

## Step 7 — File storage (15 minutes) — required on managed hosts

Managed hosts wipe local disk on every deploy, so product photos and receipt
scans need a bucket. Create one (e.g. Cloudflare R2), create an access key
limited to that bucket, and set `S3_*` on the backend.

**Check:** upload a product photo, redeploy the backend, and the photo still shows.

---

## Step 8 — DNS and HTTPS (15 minutes, then wait for propagation)

| Record | Points to |
|---|---|
| `safestores.name.ng` | GitHub Pages (A/AAAA records from GitHub's docs) |
| `app.safestores.name.ng` | your static host (CNAME) |
| `api.safestores.name.ng` | your backend host (CNAME) |

Add each custom domain in the hosting dashboard so it issues a TLS
certificate. Then update `FRONTEND_URL` (backend) and `VITE_API_URL`
(frontend) to the final addresses and redeploy both.

**Check:** all three addresses load over `https://` with a padlock.

---

## Step 9 — First sign-in as Super Admin (20 minutes)

1. Go to `https://app.safestores.name.ng/super-login` and sign in with the
   bootstrap email and password.
2. **My Account → Two-factor sign-in**: scan the QR code with an authenticator
   app. Do this before anything else.
3. **My Account → Change password**: replace the bootstrap password, then
   remove `BOOTSTRAP_SUPER_ADMIN_PASSWORD` from the backend environment.
4. **Tiers & Codes**: confirm plan limits and prices, and generate activation codes.
5. **Tiers & Codes → Payment settings**: replace the placeholder bank account
   with your real details (shown to stores when they pay).
6. **Tiers & Codes → Currency**: set the platform default currency. Each
   store can override it in its own Store Settings.

---

## Step 10 — Payments (1 hour, plus Paystack's business verification)

There are two separate money flows, and **the platform never holds
shoppers' money**:

| Flow | Who pays whom | How |
|---|---|---|
| Subscription charges | Store → you | Manual bank transfer (works now), or Paystack checkout into your own Paystack balance |
| Storefront orders | Shopper → **the store** | Paystack **split payments**: each store links its bank account once (Store Settings → Online payments); we register it as a Paystack *subaccount*, and Paystack settles every storefront payment straight to that store's bank. Pay on collection/delivery is still available. |
| Your commission on storefront orders | Store → you, **Bolt-style** | Online: withheld at source by Paystack. Pay-on-delivery: the store collects the cash, so the commission goes on the store's **balance**, which is netted automatically from its next online payments (capped per payment) or paid by the store from **Settlements**. Over your balance limit, the store's pay-on-delivery pauses until it settles. In-store till sales are never charged. |

Setup:

1. Open a Paystack business account and complete its verification (KYC) as
   the platform. Paystack is the licensed payment processor; you never touch
   the store's funds.
2. On the backend set:
   - `PAYSTACK_SECRET_KEY` — your live secret key (use the test key on staging).
   - `PAYSTACK_CURRENCIES` — the currencies your Paystack account collects,
     e.g. `NGN` (Nigeria), `GHS` (Ghana), `KES` (Kenya), `ZAR` (South Africa).
     A Paystack account is tied to one country; stores in other currencies
     keep pay on delivery.
3. Paystack dashboard → Settings → API Keys & Webhooks: set the webhook URL to
   `https://api.safestores.name.ng/api/webhooks/paystack`. It confirms both
   subscription charges and storefront payments.
4. Super Admin → Payment settings: enable the gateway for subscription charges
   (see `docs/PAYMENT_GATEWAY_SETUP.md`).
5. Super Admin → **Store Settlements**: set the commission % on storefront
   orders (default 0), the balance limit at which a store's pay-on-delivery
   pauses (0 = never), and the most of an online payment that may go to
   clearing a store's balance (default 50%). You can override the commission
   per store, record bank transfers from stores, and make adjustments.
6. Each store admin: Store Settings → **Online payments** → pick their bank,
   enter the account number, confirm the account name Paystack returns, and
   link it. Only the last 4 digits are stored by SAFE Stores.

Paystack's transaction fee is charged to the store's share (the store is the
seller). Refunds of online storefront payments are made by the store to its
customer; Paystack's dashboard also supports refunds on the original
transaction.

---

## Step 11 — Legal (before any real customer)

1. Set `VITE_LEGAL_*` (Step 5).
2. Have a lawyer review the Terms and Privacy text in
   `frontend/src/pages/Legal.jsx` for every country you sell in.
3. **Nigeria:** check whether you must register with the Nigeria Data
   Protection Commission and appoint a data-protection officer (NDPA 2023,
   depending on how many people's data you process).
4. **Lending Partners:** keep the lenders as the licensed parties. If you
   only refer stores, confirm with counsel that no licence is needed
   (e.g. from the central bank or consumer-protection regulator).
5. Signup already requires accepting the Terms and Privacy Policy.

---

## Step 12 — Launch smoke test (45 minutes)

Do this on a phone **and** a laptop, as a brand-new customer would:

- [ ] Landing page → **Start free** → register a store with a real email.
- [ ] The verification email arrives; the link confirms the address.
- [ ] Super Admin → Manage Stores: activate the store and assign a tier.
- [ ] Store admin: the Dashboard checklist appears; **Add sample products** works.
- [ ] Store Settings: set currency, time zone, 7.5% tax, receipt footer.
- [ ] Products → Import: upload the template CSV; prices come out exact.
- [ ] Labels: print one label sheet (or save as PDF).
- [ ] Invites: invite a cashier; they sign in with the code on another device.
- [ ] Cashier: **Start shift** with a float → sell 2 items → 10% discount → split cash + card → change is correct → receipt prints, QR code opens the digital receipt on a phone.
- [ ] Turn Wi-Fi off: make a sale; turn it on and watch it sync.
- [ ] Admin: Sales & Refunds → refund one item → stock goes back.
- [ ] Cashier: **End shift** → Z-report shows expected vs counted cash.
- [ ] End of Day and Insights show the sales.
- [ ] Customers: add one with a birthday; link them at the till; points appear.
- [ ] Storefront (`/shop/<storeId>`): order as a guest → **Track your order** works.
- [ ] Store Settings → Online payments: link a bank account (Paystack **test** keys on staging).
- [ ] Settlements: set a 10% commission and a small balance limit; complete a pay-on-delivery order → the store's **Settlements** page shows the commission owed and pay-on-delivery pauses on its storefront; an online order then clears the balance automatically.
- [ ] Storefront: **Pay now online** with a Paystack test card → you return to the tracking page showing **Paid**; the store's Marketplace orders list shows "Paid online"; in Paystack the transaction shows the store's subaccount.
- [ ] Share the shop link on WhatsApp → the preview shows the store name.
- [ ] Forgot password → reset works. Turn on 2FA for the store admin.
- [ ] My Account → **Download my data** works.
- [ ] Sentry shows no unexpected errors.

---

## Step 13 — Android app (1–3 days including review)

Follow `mobile/README.md`:

1. Create a Firebase project; put `google-services.json` in `mobile/android/app/`; set `FIREBASE_SERVICE_ACCOUNT` on the backend.
2. Build pointing at production:
   ```bash
   cd mobile && npm ci
   SAFE_STORES_API_URL=https://api.safestores.name.ng/api node scripts/build-www.js
   npx cap sync android
   ```
3. Create your signing key **on your own machine** and back it up in two
   places. Losing it means you can never update the app.
4. `cd android && ./gradlew bundleRelease`, then upload the `.aab` in Play
   Console. Fill in the Data safety form (it matches the Privacy Policy:
   no ads, no tracking, data encrypted in transit, deletion available in-app).
5. Once approved, replace the "Not Yet Published" card in `website/index.html`
   with the Play Store link.

---

## Step 14 — Desktop installers (1 day)

```bash
cd desktop && npm ci
npm install --save-dev electron@43.4.1   # the pending Electron upgrade (see desktop/README.md)
npm run test && npm run test:e2e
npm run prebuild && npm run build:win    # build:mac / build:linux on those systems
```

Sign the Windows installer with your code-signing certificate, and sign and
notarise the Mac build with your Apple Developer account. Upload installers
to GitHub Releases, then point the landing page's **Request Installer**
button at the release.

---

## Step 15 — Monitoring and backups (30 minutes)

- Sentry: alert email for new issues on both projects.
- Uptime check (UptimeRobot, Better Stack or similar, free tier) on
  `https://api.safestores.name.ng/api/health` every minute.
- Database: confirm daily backups exist, then **test a restore** into a
  scratch database once before launch.
- Keep `npm audit` clean: backend CI fails on moderate+ production advisories.

---

## Launch day

1. Re-run the smoke test (Step 12) on production.
2. Announce on the landing page and social channels, with WhatsApp share links to stores' shops.
3. Watch Sentry and the uptime monitor for the first 48 hours.
4. Handle Support tickets from Super Admin → Support Tickets daily.

---

## Cancelling storefront orders

Stores can cancel an order that has not been fulfilled (Online Marketplace →
Cancel, with an optional reason the shopper sees on the tracking page).
Pay-on-delivery orders: nothing is owed. Paid online: the money is already
in the store's account, so the order shows **Refund due** — the store
refunds the shopper from its Paystack dashboard, then taps **Mark refunded**.
The platform's commission on that order is credited back to the store's
settlement balance automatically.

## Known limitations (plan for v27)

- **Desktop ↔ cloud sync** now carries shifts, split payments, refunds,
  discounts/tax and barcodes too. Loyalty points and customer records stay on
  the device that created them (customers are not synced yet).
- **Translations:** v26 screens are in English in all 8 languages until a
  native speaker translates the new keys in `frontend/src/i18n/locales/*.json`
  (the app falls back to English). The Super Admin console is English-only.
- **Online storefront payments** use Paystack (Nigeria, Ghana, Kenya, South
  Africa). For stores elsewhere, add Stripe Connect (Express accounts), which
  follows the same "money goes straight to the store" model; until then
  those stores use pay on delivery.
- **Branch transfers** need the same email on an admin or manager account at
  both stores (an owner of several branches).

## Licences

Every bundled dependency uses a permissive open-source licence (MIT, ISC,
BSD, Apache-2.0). Their notices ship with the app at `/licenses`, generated
on every build by `frontend/scripts/licenses.mjs`. Map tiles, SMS gateways
and paid barcode databases were deliberately not used.
