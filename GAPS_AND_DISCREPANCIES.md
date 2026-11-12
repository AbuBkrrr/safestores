# Gap Analysis — Two Source Documents vs. the Real System

You uploaded two documents. They describe two different points in this
project's life, not two versions of the same thing:

- **`____SAFE_Stores_-_Complete_Invento.txt`** — an early spec (marked
  "Version 5.0") for a *single-file HTML prototype*: everything in one
  `index.html`, data in the browser's `localStorage`, no real backend,
  no real database, no real multi-device sync.
- **`SAFE-Stores-Company-Walkthrough.pptx`** — a walkthrough of the
  *actual current system*: real Node/PostgreSQL (or SQLite for desktop)
  backend, real multi-user accounts, real offline sync, three real
  editions (Web, Desktop, Android).

The short answer: **the prototype spec was entirely superseded, not
extended.** Every feature it describes exists in the real system in a
more robust form — real accounts instead of `localStorage` objects, a
real database instead of a browser storage key, real multi-device sync
instead of a single browser tab. Below is the actual reconciliation:
what's genuinely equivalent, what's a real upgrade, what few things were
genuinely missing (now fixed), and what remains — honestly — outside
what this session could complete.

---

## 1. What the prototype spec described vs. what's real now

| Prototype spec (old) | Real system (current) | Verdict |
|---|---|---|
| Data in browser `localStorage` | Real PostgreSQL (cloud) / SQLite (desktop) database, with 26+ migrations, full referential integrity | **Upgraded** — this was the single biggest limitation of the prototype (data tied to one browser, one device, easily lost) |
| Single HTML file, no backend | Full Express/Node backend (cloud + desktop), React frontend, Electron shell, Android Capacitor shell | **Upgraded** |
| Hardcoded default Super Admin password (`SuperAdmin2024!`) | Super Admin created via `BOOTSTRAP_SUPER_ADMIN_EMAIL`/`PASSWORD` env vars (web) or a real setup wizard (desktop) — no shipped default credential at all | **Upgraded** (the old approach was a real security liability) |
| "Confidence Source" field on audits (Manual Verified / AI High Confidence / AI Needs Review) | Two-counter conflict detection: if two people count the same location differently, it's auto-flagged for recount rather than silently trusting one number | **Different, and more robust** — no AI-confidence self-reporting to trust; disagreements are structurally caught |
| Bulk user creation, invite codes | Same concept, real: `Invites.jsx`, single-use codes, bulk creation with auto email-domain assignment | **Equivalent, real** |
| WhatsApp / SMS / native share for invites | All three implemented (`Invites.jsx`: `wa.me` links, `sms:` links, `navigator.share`) | **Equivalent, real** |
| Bluetooth / Xender sharing | Not implemented | **Genuinely absent** — see §3 |
| Camera + QR/barcode scanner | Real, native barcode scanning via `@zxing/browser` (web) and a native camera plugin (Android), working fully offline | **Upgraded** |
| OCR receipt scanner | Real Tesseract.js OCR, parses line items, matches or creates products, posts stock automatically | **Equivalent, real** |
| Analytics dashboard (Chart.js) | Real analytics endpoints + charts: stock value, top products, movement trends, reorder alerts | **Equivalent, real** |
| CSV/JSON export | Real, same formats, real endpoints (`export/csv`, `export/json`) | **Equivalent, real** |
| Print report | Real (`window.print()` in `Reports.jsx` and `Checkout.jsx` for receipts) | **Equivalent, real** |
| Email report on demand | Not implemented as an ad-hoc "email me this report" feature | **Genuinely absent** — see §3 |
| PWA manifest (`manifest.json`) | Was missing entirely | **Fixed this session** — see §2 |
| Offline sync | Real IndexedDB-backed write queue + read cache, auto-replay on reconnect, realtime updates across devices while online | **Upgraded** — the old spec's offline sync was a single-tab `localStorage` queue with no cross-device sync at all |
| Three subscription tiers | Real: Mini/Midi/Vision-style tiers with product/user limits, access codes, billing | **Equivalent, real** |
| Multi-platform (implied single web app) | Three real, separate editions sharing one React codebase: Web, Desktop (Electron), Android (Capacitor) | **Upgraded** |

---

## 2. Fixed this session

Cross-checking the walkthrough deck against the actual codebase surfaced
a small number of genuine, addressable gaps. All are now fixed:

- **No PWA manifest.** `frontend/public/manifest.json` now exists (with
  two brand-teal placeholder icons), wired into `index.html`. The web
  edition can now be "Added to Home Screen" on mobile browsers as a
  standalone app — this was in the original spec and had never been
  carried into the real build.
- **No public download page.** This was the walkthrough deck's own
  explicitly flagged gap ("the missing first step of this whole
  walkthrough"). `website/index.html` is a real, complete, responsive
  landing page for `safestores.name.ng` — see `website/README.md` for
  the three placeholder links that need pointing at real hosted
  artifacts once they exist.
- **Vague Android signing instructions.** `mobile/README.md` now has
  exact `keytool`/`gradlew` commands instead of "Android Studio walks
  you through this." (I deliberately did **not** generate a real signing
  keystore myself and hand it to you — a signing key that's passed
  through any third party, including me, is no longer trustworthy as
  private. This is one to generate yourselves, on your own machine.)
- **Domain not reflected anywhere.** `safestores.name.ng` (noted as
  subject to change) is now the example value in `.env.example`,
  `.env.staging.example`, and the new landing page. Nothing in the
  actual application hardcodes it — `FRONTEND_URL` was already a proper
  environment variable before this pass, so a future domain change is a
  one-line config edit, not a code change.

---

## 3. Genuinely absent, and a judgment call on each

- **Bluetooth / Xender device-to-device sharing.** The old spec listed
  this; it's not built. Worth naming honestly: there's no standard way
  for a web app to trigger "share via Xender" specifically (Xender is a
  proprietary Android app with no public web API), and Web Bluetooth
  for arbitrary file transfer between two random phones is unreliable in
  practice. On Android specifically, wiring `navigator.share` through
  Capacitor's native Share plugin would surface Bluetooth/Xender/
  whatever's installed via the OS's own share sheet automatically — a
  real, buildable upgrade if this matters to you, but not done in this
  pass since it wasn't a launch-blocking item you'd named.
- **On-demand "email me this report."** Real email sending already
  exists in the backend (nodemailer, used for support-ticket
  notifications) — extending it to attach and send an arbitrary report
  on request is a genuinely small addition, just not one that was asked
  for or built yet.

---

## 4. What remains outside what this session could complete

These aren't code gaps — they're real-world steps requiring accounts,
credentials, or review processes that only you can do:

- **A real Firebase project + `google-services.json`.** The push
  notification *code* is fully wired (`frontend/src/mobile/push.js`,
  backend `push.js`, the `device_push_tokens` table) — it's a safe
  no-op until this file exists. See `mobile/README.md` step 2.
- **Signing + Google Play submission.** Instructions are now precise
  (§2), but the key itself and the Play Console account ($25, real
  identity verification) have to come from you.
- **Real hosting.** `DEPLOYMENT.md` and the Docker images are ready and
  verified (see the earlier session notes on Docker verification) — but
  an actual server/domain/TLS certificate is a real infrastructure
  decision, not something fabricable in a sandbox.
- **A professionally designed logo/icon.** The current icons
  (`frontend/public/icon-*.png`, `website/icon-192.png`) are simple
  programmatic placeholders in the brand teal — functional, not final.
  Worth a real design pass before public launch.
- **The Electron version upgrade** (flagged in an earlier session) is
  still on the original 31.3.1 — attempted and reverted after hitting a
  sandbox-specific network restriction (not a code problem); very likely
  safe to complete on a machine with normal internet access, per the
  breaking-changes research already done.

---

## 5. Confusions worth clearing up explicitly

- The prototype spec's data models (Store/User/Product/Movement/Audit/
  Invite/Receipt/AccessCode as JSON shapes) are **not** the real
  database schema — don't use that section as a reference for API
  shapes or database columns. The real shapes are documented implicitly
  through the backend's test suites (`backend/tests/`, `desktop/tests/`)
  and the migration files themselves (`backend/migrations/`,
  `desktop/server/schema.sqlite.sql`), which are the actual source of
  truth.
- The prototype spec's "LocalStorage Keys" and "JavaScript Functions"
  sections describe an architecture that no longer exists at all — there
  is no `DB.get()`/`DB.set()` localStorage wrapper anywhere in the real
  codebase. Real state lives in the database; the frontend talks to it
  over the real API (`frontend/src/api/client.js`).
- The walkthrough deck's Slide 4 says desktop is "buildable today" — to
  be precise, that means `npm run build:win/mac/linux` in `desktop/`
  produces a real installer once you run it on your own machine (it
  needs to run on each target OS, or use `electron-builder`'s
  cross-build support — see `desktop/README.md`). It was not pre-built
  into this zip; installers are large, platform-specific binaries that
  don't belong in source control.

---

## 6. Hardtest pass — desktop/cloud feature-parity audit (this session)

Cross-checked every controller/route registered on the cloud backend
against the desktop (SQLite/Electron) backend, since the shared React
frontend renders identically on both editions regardless of which
backend is actually behind it.

**Found and fixed — a real, live bug:**
- `store_customers` / `customer_ledger_entries` (customer credit /
  "owing book" tracking, and the "Credit (pay later)" checkout option)
  existed only on the cloud backend. On desktop, the Customers nav item
  was visible to admin/manager, the page loaded but silently showed an
  empty list (unhandled promise rejection, no `.catch()`), and selecting
  credit at checkout did nothing. Fixed: SQLite tables added to
  `schema.sqlite.sql` (idempotent — picked up automatically on next
  launch, no manual migration), full controller ported to
  `desktop/server/controllers/customersController.js`, routes wired,
  `payOrder` now posts a real `credit_sale` ledger entry, nav role list
  fixed (`staff` was missing), and the two frontend fetches that failed
  silently now surface an error instead. 11 new desktop tests, mirroring
  the cloud suite's coverage exactly.

**Found and fixed — a real but not-yet-live gap:**
- `analytics/shrinkage` (shrinkage report — value lost from shelf-audit/
  cycle-count discrepancies) also existed only on the cloud backend.
  Unlike customers, **nothing in the frontend calls this endpoint yet**
  (no consumer anywhere in `frontend/src/`), so this wasn't an active
  bug — just an inconsistency waiting to bite whoever wires up a
  Shrinkage page later, at which point it would've silently 404'd on
  desktop exactly like Customers did. Fixed the same way: ported to
  `desktop/server/controllers/analyticsController.js`, route wired,
  4 new tests mirroring the cloud suite.

**Checked and confirmed NOT a bug:**
- `lending-partners` (the bank/microfinance partner registry) is
  genuinely cloud-only by design — it's a cross-store, super-admin-
  managed concept with no per-store analog, same category as
  marketplace/auditor. Confirmed **zero frontend consumer exists for it
  at all** (not even on cloud), so it's inert scaffolding, not a broken
  feature. Worth knowing it's unfinished if anyone plans to build a UI
  for it.

**Re-verified, not re-litigated:**
- Full desktop suite: 31 test files, 223 tests, all passing (up from
  219 — the 4 new shrinkage tests) after every change above.
- Full frontend suite: 9 files, 54 tests, all passing.
- Cloud backend suite (353 tests as of the last session) needs a real
  Postgres instance to run — not available in this sandbox, and no
  cloud code was touched this pass, so there's no new regression risk,
  but it was not re-run to independently confirm it's still green.
- `npm audit`: frontend still has the one known dev-server-only
  vite/esbuild advisory (not a production risk, matches the earlier
  documented decision not to force a breaking upgrade for it). Desktop
  still has the ~24 Electron 31.3.1 advisories.
- **Re-attempted the Electron 31→43 upgrade** (previously flagged as
  "very likely fine on a machine with normal internet, blocked here by
  a sandbox network restriction"). Confirmed the same blocker persists
  in this sandbox too, and pinned down exactly why: `npm install
  --save-dev electron@43.4.1` itself succeeds (matches the version
  already in the CI workflow's cache-friendly path), and the desktop
  Jest suite (219 business-logic tests, run under plain Node) stayed
  100% green against it — but `electron-rebuild`, needed to rebuild
  `better-sqlite3`'s native binding against Electron's own ABI (required
  for the app to actually launch, and for the real Playwright e2e
  window-lifecycle test to run), fails with a 403 fetching
  `https://www.electronjs.org/headers/...` — that domain isn't on this
  sandbox's egress allowlist, unlike `release-assets.githubusercontent.com`
  (which is why the plain `npm install` step itself works). Reverted the
  version bump rather than leave the repo in a half-upgraded state where
  `npm test` passes but the app plausibly can't actually launch. **This
  is a real, low-effort win for whoever runs it next**: on a normal
  machine, `cd desktop && npm install --save-dev electron@43.4.1 &&
  npm run test:e2e` should complete cleanly — the only thing blocking it
  here was this sandbox's specific domain allowlist, not the code.
- i18n: done (v24). All 37 pages/components translated across 8 locales
  (918+ keys, full parity checked). Fixed in this pass: 4 broken
  `suppliersPage.*` keys that rendered raw key names, untranslated
  Setup + Super Admin login pages, and the switcher's aria-label.
  Remaining: native-speaker review of non-English strings.
- CI/CD: contrary to the very first assessment in this project's
  history, this now genuinely exists — `.github/workflows/{backend,
  frontend,desktop}-ci.yml`, each running its real test suite (plus the
  desktop one running the real Playwright e2e suite under Xvfb) on every
  push/PR. Error monitoring (`@sentry/node` / `@sentry/react`) is also
  genuinely wired on all three surfaces — confirmed via each suite's own
  errorMonitoring tests — and is a safe no-op until a real `SENTRY_DSN`
  is set, which is a one-time account-creation step covered in
  `GO_LIVE.md` Step 4.
