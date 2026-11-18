# SAFE Stores — Desktop Edition (Electron)

A true desktop app version: double-click installer, desktop shortcut, Start Menu
entry, runs fully offline with an embedded SQLite database — no separate
database server, no `.env` file to edit, no terminal required for end users.

## Important: you need to build the installer yourself

I can't produce the finished `.exe`/`.dmg` file directly — building it requires
running Electron and downloading packages, which needs an internet connection
I don't have in this environment. What's here is the **complete, correct source
code**. You'll run a couple of commands **once**, on your own Windows/Mac/Linux
machine, to produce the real installer. After that, the installer file itself
is what you'd hand to end users — they never see a terminal.

## What you need on your build machine

- Node.js 18+ (which includes npm) — https://nodejs.org
- Windows: no extra tools needed for a standard build
- (Only if `better-sqlite3`'s prebuilt binary doesn't match your Node/Electron
  version, which is rare): a C++ build toolchain. If you hit a build error
  mentioning `node-gyp`, install "Build Tools for Visual Studio" (Windows) or
  Xcode Command Line Tools (`xcode-select --install` on Mac).

## Build steps (run once, on your machine)

```bash
cd safe-stores/desktop
npm install
```

This also runs `electron-builder install-app-deps` automatically, which
rebuilds the native `better-sqlite3` module for Electron's Node version.

Then build the installer for your platform:

```bash
# Windows installer (.exe, with desktop shortcut + Start Menu entry)
npm run build:win

# Mac installer (.dmg)
npm run build:mac

# Linux (.AppImage)
npm run build:linux
```

Each of these first builds the React frontend automatically (via the
`prebuild` script), then packages everything with `electron-builder`.

## Running the tests

There are two separate test suites, and they need `better-sqlite3` built
for two DIFFERENT native ABIs — this is the single most common way to
confuse yourself working on this codebase, so it's worth understanding
rather than just memorizing the commands:

- `npm test` — the Jest suite (`tests/`), ~200 tests against a mocked
  `electron` module, running under **plain Node.js**. Needs
  `better-sqlite3` built for Node's ABI.
- `npm run test:e2e` — the Playwright suite (`e2e/`), which launches the
  **real Electron binary** (real window, real menu, real embedded
  server) via Playwright's Electron mode. Needs `better-sqlite3` built
  for **Electron's** ABI instead. Requires a display — on a headless
  Linux CI box or container, run it under `xvfb-run npm run test:e2e`
  (or start `Xvfb` yourself and set `DISPLAY`).

Both npm scripts already rebuild the correct ABI for you automatically
(`npm rebuild better-sqlite3` before Jest, `electron-rebuild --force`
before Playwright) — you don't need to think about this to just run
`npm test` or `npm run test:e2e` on their own. The gotcha only bites if
you reach for a bare `npx jest` or `npx playwright test` directly,
bypassing the npm script's rebuild step, right after running the other
suite — you'll get a `NODE_MODULE_VERSION` mismatch / `ERR_DLOPEN_FAILED`
error. If you see that, the fix is always one of the two rebuild
commands above, matching whichever suite you're about to run.

The finished installer will be in `desktop/release/`. That's the file you
double-click to install — it will:
- Install the app (letting the user pick the install folder, like a normal
  Windows program)
- Create a **desktop shortcut** and Start Menu entry (both enabled in
  `package.json`'s `nsis` config)
- On first launch, show a one-time **Setup Wizard** to create the Super
  Admin account (no `.env` file involved)
- Store its database and uploaded images in the correct per-user app data
  folder (`%APPDATA%/SAFE Stores` on Windows) — not Program Files, which is
  the correct, permission-safe place for an app's data to live even though
  the *program itself* installs to Program Files

## What "fully offline" means here

Once built and installed:
- The embedded Express server and SQLite database run **inside** the app —
  no internet connection needed for any core feature (auth, products,
  stock, invites, analytics, exports, etc.)
- The receipt OCR is a documented, swappable **simulated** extractor
  (see `server/utils/ocr.js`) — plug in `tesseract.js` for real fully-offline
  OCR, since that library runs locally with no API calls
- Invite-sharing buttons (WhatsApp/SMS/email) open external apps/links —
  those obviously need connectivity themselves to actually send, same as
  clicking those links anywhere else, but the app's own data and logic
  don't depend on it

## Updating the app later

Since there's no auto-updater wired in yet, distributing a new version means
sending users a new installer to run — their existing database (in the
per-user app-data folder) is untouched by re-installing, since installers
only replace the app-folder contents, not user data.

## Icon

A simple placeholder icon is included in `build/icon.png` / `build/icon.ico`.
Swap those out (keep the same filenames) with your own artwork before
building if you want custom branding — recommended size 512×512 for the PNG.
