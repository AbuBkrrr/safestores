# Store app template

Every store that signs up gets **its own Windows installer and Android app**:
its name, its initials as the icon, a unique app id, and no platform
branding anywhere (window titles, installer, shortcuts, app screens,
translations, file names). This folder is the template those apps are made from.

| File | What it does |
|---|---|
| `apply.js` | Turns the shared app into one store's app before building: renames every visible "SAFE Stores" in the screens and the 8 translations, sets the app name, publisher and a unique app id (`com.storeapp.s<store id>`), and points the app at the store. |
| `make-icons.sh` | Draws the store's icons (initials on the brand teal) for Windows, the Android launcher and the splash screen. |
| `../../.github/workflows/store-app.yml` | Runs the two scripts and builds the Windows installer (`store-windows.exe`) and the Android app (`store-android.apk`), then puts them on a release tagged `store-<id>`. |

## How it runs

1. A store signs up → the server starts the **Store apps** workflow with the
   store's id, name and size (Mini, Midi or Mega).
2. About 10 minutes later the files are on the store's release. The sign-up
   pop-up (and **Store Settings → Your own apps**) turns into two download
   buttons. Files are served by the server as `<Store name> Setup.exe` and
   `<Store name>.apk`, so the download address shows your domain, not GitHub.
3. Renamed a store? **Super Admin → Manage Stores → 📲 Rebuild apps.**

## Customising the template

- Colours and icon style: edit `make-icons.sh` (`#0f7180` is the brand teal).
- Anything else the store build changes: edit `apply.js`.
- Try a store build by hand: **Actions → Store apps → Run workflow** and fill
  in a store id, name, size and the server address (`https://app.<your domain>/api`).

## Server settings (once)

In `/opt/safestores/.env`, then `docker compose up -d backend`:

```
GITHUB_TOKEN=<fine-grained token for this repository: Actions read/write, Contents read>
GITHUB_REPO=AbuBkrrr/safestores
```

Without `GITHUB_TOKEN` sign-up still works; the store sees "your apps will
appear here once they are ready", and you can build them later with Rebuild apps.

### Android updates (recommended)

Add these repository secrets so every store app is signed with the same key
and phones can install updates over the old version:
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`ANDROID_KEY_PASSWORD`. Without them the app is debug-signed (it installs, but
a rebuilt app may need the old one removed first).
