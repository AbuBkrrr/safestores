# SAFE Stores — Public Website

A single-file static landing/download page for `safestores.name.ng` — this
is what Slide 16 of the company walkthrough calls "the missing first
step": a public page where someone can actually get the app.

## What this is

`index.html` is self-contained (no build step, no framework — just HTML/CSS,
with fonts loaded from Google Fonts). Open it directly in a browser to
preview it, or deploy it as-is to any static host (Netlify, Vercel,
Cloudflare Pages, S3+CloudFront, or a folder on the same server running the
backend).

The icon (`icon-192.png`) is a simple placeholder in the app's brand teal
(`#0f7180`) — **replace this with a real designed logo before public
launch.** It's functional, not final.

## What still needs to be wired up before this goes live

Three links in the page are placeholders, clearly marked with HTML
comments at each spot in `index.html`:

1. **"Open Web App"** — currently points to `https://safestores.name.ng/app`.
   Update once the frontend is actually deployed there (see
   `../DEPLOYMENT.md`).
2. **"Request Installer"** — currently scrolls to the contact section.
   Once you've built and hosted real desktop installers (see
   `../desktop/README.md` for the build steps), point this at wherever
   you're hosting those `.exe`/`.dmg`/`.AppImage` files.
3. **Android card** — intentionally shows "Not Yet Published," matching
   the real current state (see `../mobile/README.md`). Once the app is
   live on Google Play, replace this card's button with a real Play Store
   link.

## Domain note

`safestores.name.ng` is noted as "subject to change." If it changes,
this page needs the two `safestores.name.ng` references in `index.html`
(the receipt's subtitle and the Web App link) updated to match — nothing
elsewhere in the codebase hardcodes this domain (see `../DEPLOYMENT.md`
and `.env` `FRONTEND_URL` for how the actual application handles this
correctly via environment variables).
