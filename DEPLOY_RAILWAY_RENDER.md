# Deploy: GitHub → Railway / Render

This is a copy-paste guide for getting the **web app edition** (`backend/`
+ `frontend/`) from this folder onto GitHub and then live on Railway
and/or Render. For general deployment background (Docker, VPS, secrets
management, pre-launch checklist), see [`DEPLOYMENT.md`](./DEPLOYMENT.md)
— this file is the fast, literal, copy-paste path.

**Not covered here** — these aren't web deploys, they're separate build
processes you run locally: `desktop/` (see `desktop/README.md`), `mobile/`
(see `mobile/README.md` if present), and `website/` (a static marketing
site — deployable the same way as the frontend's static-site steps below,
if you want it hosted).

---

## Step 0 — One-time setup on your own machine

You need `git` installed and accounts on **GitHub**, and whichever of
**Railway** and/or **Render** you're using (both have free tiers that
cover this).

Generate the two secrets you'll need in a minute — run these now and
save the output somewhere, you'll paste them into Railway/Render shortly:

```bash
# JWT_SECRET — paste the output when asked for it below
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# A strong bootstrap Super Admin password — paste the output when asked
node -e "console.log(require('crypto').randomBytes(16).toString('base64'))"
```

If you don't have Node.js installed locally to run those, use this
instead (works on macOS/Linux, and Windows via WSL or Git Bash):

```bash
openssl rand -hex 48      # for JWT_SECRET
openssl rand -base64 16   # for the Super Admin password
```

---

## Step 1 — Push this project to GitHub

From the root of this folder (the one containing `backend/`, `frontend/`,
etc.):

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
```

Create a new **empty** repository on GitHub (github.com → New repository
— don't initialize it with a README, .gitignore, or license, since this
folder already has those). Then:

```bash
git remote add origin https://github.com/<your-username>/<your-repo-name>.git
git push -u origin main
```

Replace `<your-username>` and `<your-repo-name>` with your actual values.
Everything after this point happens in Railway's/Render's web dashboard,
pointed at this GitHub repo.

---

## Option A — Everything on Render (fastest path)

This repo includes [`render.yaml`](./render.yaml) at the root, which
Render reads automatically to provision the database, backend, and
frontend together in one pass.

1. Go to the Render dashboard → **New** → **Blueprint**.
2. Connect your GitHub account if you haven't already, then select the
   repo you just pushed.
3. Render reads `render.yaml` and shows you a preview of what it's about
   to create: a Postgres database, the backend (Docker web service), and
   the frontend (static site). Click **Apply** / **Deploy Blueprint**.
4. Render will pause and ask you to fill in the values marked `sync:
   false` in the blueprint — paste in:
   - `JWT_SECRET` → the hex string from Step 0
   - `BOOTSTRAP_SUPER_ADMIN_EMAIL` → the email you want to log in with
     as the first Super Admin (e.g. `admin@yourcompany.com`)
   - `BOOTSTRAP_SUPER_ADMIN_PASSWORD` → the base64 string from Step 0
5. Wait for both services to finish deploying (watch the build logs in
   the dashboard). The backend's start command runs database migrations
   itself before booting the server (see the comment in `render.yaml`) —
   you'll see `Applying 001_initial.sql ...` etc. in the logs on first
   deploy, then `Already up to date` on every deploy after that.
6. Visit `https://safestores-frontend.onrender.com` (or whatever URL
   Render assigned — shown on the frontend service's page) and log in
   with the Super Admin email/password from step 4.

That's it — skip to **Step 2: verify it worked**, below.

**If you rename either service** away from `safestores-backend` /
`safestores-frontend` in the Render dashboard, or attach a custom domain,
edit the two hardcoded URLs in `render.yaml` (`FRONTEND_URL` and
`VITE_API_URL`) to match, commit, and push — Render redeploys
automatically on push.

---

## Option B — Backend on Railway, frontend on Render

Use this if you specifically want Railway for the backend (e.g. pricing
preference). Railway doesn't have a single-file "deploy everything"
blueprint the way Render does, so this is dashboard-driven.

### B1 — Backend + Postgres on Railway

1. Railway dashboard → **New Project** → **Deploy from GitHub repo** →
   select your repo.
2. Railway will try to auto-detect a service from the repo root — click
   into that service's **Settings** and set:
   - **Root Directory**: `backend`
   - Railway will now find `backend/Dockerfile` and `backend/railway.json`
     automatically and build from those. `railway.json` also sets the
     start command to run database migrations before booting the server
     (same idempotent, safe-to-repeat migration script the Docker
     Compose setup in `DEPLOYMENT.md` uses) — you don't need to trigger
     migrations separately.
3. In the same project, click **New** → **Database** → **Add PostgreSQL**.
   Railway provisions it and exposes a reference variable automatically.
4. Go back to your backend service → **Variables** tab → **Raw Editor** —
   paste this whole block in one go, then edit the placeholder lines
   marked `<<< …`:

   ```
   NODE_ENV=production
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   DATABASE_SSL=require
   DB_POOL_MAX=10
   JWT_SECRET=<<< paste the hex string from Step 0
   JWT_EXPIRES_IN=7d
   FRONTEND_URL=<<< fill this in after Step B2 below — see note
   BOOTSTRAP_SUPER_ADMIN_NAME=Super Admin
   BOOTSTRAP_SUPER_ADMIN_EMAIL=<<< the email you want to log in with
   BOOTSTRAP_SUPER_ADMIN_PASSWORD=<<< paste the base64 string from Step 0
   ```

   `${{Postgres.DATABASE_URL}}` is Railway's own variable-reference
   syntax — leave that line exactly as written; Railway substitutes the
   real connection string automatically. (If your Postgres service isn't
   named "Postgres" in your project, adjust the reference to match its
   actual service name, shown in the Railway dashboard sidebar.)

5. Deploy. Once it's live, copy the public URL Railway assigns (Settings
   → Networking → **Generate Domain** if one isn't there yet — looks like
   `https://your-service.up.railway.app`). You'll need it in Step B2.
6. Come back and fill in `FRONTEND_URL` above once you have the frontend's
   URL from Step B2, then redeploy (Railway redeploys automatically when
   you change a variable).

### B2 — Frontend as a static site on Render

1. Render dashboard → **New** → **Static Site** → connect the same
   GitHub repo.
2. Set:
   - **Root Directory**: `frontend`
   - **Build Command**: `npm ci && npm run build`
   - **Publish Directory**: `dist`
3. **Environment** tab → add one variable:
   ```
   VITE_API_URL=<<< the Railway backend URL from Step B1.5, e.g. https://your-service.up.railway.app
   ```
4. **Redirects/Rewrites** tab → add one rule (required for React Router —
   without this, refreshing any page other than the homepage 404s):
   - Source: `/*`
   - Destination: `/index.html`
   - Action: **Rewrite**
5. Deploy. Copy the resulting URL (`https://your-site.onrender.com`) and
   go back to Step B1.6 to finish wiring `FRONTEND_URL` on the backend.

---

## Step 2 — Verify it worked

```bash
# Replace with your actual backend URL
curl https://<your-backend-url>/api/settings/currency
```

You should get back JSON like `{"code":"NGN","symbol":"₦"}` — this
confirms the backend is up, migrated, and reachable. Then open the
frontend URL in a browser and log in with the Super Admin email/password
you set above.

---

## Common issues

- **Frontend loads but every API call fails / CORS error in the browser
  console** — `FRONTEND_URL` on the backend doesn't exactly match the
  frontend's real URL (must include `https://`, no trailing slash). Fix
  it in that service's environment variables and redeploy.
- **Refreshing any page but the homepage shows a 404** — the static
  site's SPA rewrite rule (Option A: already in `render.yaml`; Option B:
  Step B2.4) is missing or misconfigured.
- **Backend won't start / crashes on boot** — check the deploy logs for a
  migration error first (the start command runs `node src/db/migrate.js`
  before `node server.js` — see `render.yaml`/`backend/railway.json`);
  this is almost always `DATABASE_URL` being wrong or the database not
  being reachable yet on the very first deploy — redeploying the backend
  once the database shows "Available" usually fixes it.
- **Scaling the backend to more than one instance later** — both configs
  run migrations on every boot, which is safe for a single instance
  (migrations are idempotent — see `backend/src/db/migrate.js`) but can
  race if two instances start at once and both try to apply the same new
  migration. If you scale up, switch to your platform's pre-deploy /
  release-phase command instead (Render and Railway both support this on
  paid plans) and remove the migration step from the start command.
- **Can't log in as Super Admin** — the bootstrap account is only created
  on a *fresh* database, once. If you're not sure whether it ran, check
  the backend's boot logs for a line confirming it, or connect to the
  database directly and check the `super_admins` table.

## After launch

Go through the **Pre-launch checklist** in [`DEPLOYMENT.md`](./DEPLOYMENT.md#pre-launch-checklist)
before pointing real users at this — object storage (`S3_BUCKET`), error
monitoring (`SENTRY_DSN`), and a real database backup schedule are the
three most commonly forgotten items on a first deploy.
