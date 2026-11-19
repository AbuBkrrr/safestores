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

## Buttons and links

Every button goes somewhere real:

- **Start free / Create your shop / Sign in** go to the web app on
  `app.safestores.name.ng` (`/signup`, `/login`).
- **Request the installer, Tell me when it's out, Book a free setup
  visit, Ask for your rate** jump to the contact form and pick its topic.
- The **contact form** has no server: it opens the visitor's email app
  with a message to `support@safestores.name.ng`, filled in and ready to
  send. Swap that for a form service later if you want submissions
  stored.

When desktop installers are hosted, point the **Request the installer**
button (in the Download section) at the files instead of the form.
