# SAFE Stores — Mobile Edition (Android)

Reuses `frontend/`'s React app inside a native Android shell via Capacitor. No separate mobile codebase to maintain — the same UI, same offline queue, same everything as the web edition, just packaged as an installable app with push notifications and a real app icon/splash screen.

## What's already built here
- `android/` — a real, complete native Android Studio project (Gradle wrapper, manifest, plugin modules for Camera/Network/Push Notifications/Splash Screen/Status Bar). Generated via `npx cap add android` and already synced with a real frontend build.
- App icon + adaptive icon + splash screen (light & dark) generated for every density, in the app's brand teal (`#0f7180`) — see `assets/` for the source images if you want to redo the branding.
- `AndroidManifest.xml` has the permissions the wired plugins actually need: `INTERNET`, `CAMERA`, `POST_NOTIFICATIONS` (required at runtime on Android 13+), `WAKE_LOCK`.
- Push notifications are wired end-to-end, not just installed: `frontend/src/mobile/push.js` requests permission and registers the device's FCM token with the backend on login (`POST /api/push/register`), backend stores it (`device_push_tokens` table, migration `023`), and three real events already push through it — a new Marketplace order, a shelf-audit recount conflict, and a support ticket reply (see `backend/src/utils/push.js` for the sending side, and its call sites in `marketplaceController.js`, `inventoryController.js`, and `supportController.js`).
- `google-services.json`-detection is already wired into `android/app/build.gradle` (Capacitor's own template does this) — the Google Services Gradle plugin auto-applies the moment that file exists, no manual Gradle editing needed.

## What you still need to do locally
This part genuinely can't be done in a sandboxed environment — it needs Android tooling talking to Google's servers, which this build environment doesn't have network access to.

1. **Install Android Studio** (includes the Android SDK) — https://developer.android.com/studio
2. **Create a Firebase project** at https://console.firebase.google.com, add an Android app with package name `com.safestores.app` (must match `capacitor.config.json`'s `appId`), download the generated `google-services.json`, and place it at `mobile/android/app/google-services.json`.
3. **Get a Firebase service account key** for the *backend* side: Firebase Console → Project Settings → Service Accounts → Generate new private key. Set it as `FIREBASE_SERVICE_ACCOUNT` (the JSON, minified to one line) or `FIREBASE_SERVICE_ACCOUNT_PATH` (a file path) in the backend's `.env`. Until this is set, push sends are a safe no-op — everything else keeps working, devices just won't get pushes.
4. **Build the real web bundle**, pointed at your actually-deployed backend (not localhost):
   ```bash
   cd mobile
   npm install
   SAFE_STORES_API_URL=https://api.yourdomain.com/api node scripts/build-www.js
   npx cap sync android
   ```
5. **Open in Android Studio**: `npx cap open android` (or open the `mobile/android` folder directly). Let it finish its first Gradle sync (this is the step that needs internet access to Google's Maven repo — Android Studio handles this itself).
6. **Run on a device/emulator** to test, then generate a signed release build when ready to distribute:
   ```bash
   # Run this ONCE, on your own machine — never on a shared/CI machine,
   # never commit the output anywhere (already covered by the root
   # .gitignore's *.jks/*.keystore rule). This key is what proves every
   # future update really comes from you — back it up somewhere private
   # and durable (a password manager's file storage, an encrypted drive).
   # If you lose it, you cannot publish an update to the same Play Store
   # listing ever again; you'd have to publish as a brand new app.
   keytool -genkeypair -v -keystore safestores-release.keystore \
     -alias safestores -keyalg RSA -keysize 2048 -validity 10000
   ```
   It'll prompt for a keystore password, a key password, and your
   organization details — keep the passwords as safe as the file itself.
   Then either let Android Studio's **Build → Generate Signed Bundle/APK**
   wizard point at that file, or build from the command line:
   ```bash
   cd android
   ./gradlew bundleRelease \
     -Pandroid.injected.signing.store.file=/path/to/safestores-release.keystore \
     -Pandroid.injected.signing.store.password=YOUR_KEYSTORE_PASSWORD \
     -Pandroid.injected.signing.key.alias=safestores \
     -Pandroid.injected.signing.key.password=YOUR_KEY_PASSWORD
   ```
   This produces `android/app/build/outputs/bundle/release/app-release.aab` —
   the `.aab` file Google Play actually wants (not a plain `.apk`).
7. **Google Play**: create a developer account ($25 one-time), fill out the store listing, upload the signed `.aab`, and submit for review.

## Notes
- `@capacitor/camera` is installed but the app doesn't actually need it — `Camera.jsx` already uses the standard web `getUserMedia()` API, which works fine inside the Android WebView with the `CAMERA` permission already in the manifest. Left installed in case you want a native camera picker UI later; not load-bearing today.
- Rebuilding icons/splash after changing `assets/*.png`: `npx capacitor-assets generate --android --iconBackgroundColor '#0f7180' --splashBackgroundColor '#0f7180'` (run from `mobile/`, needs `@capacitor/assets` — already a devDependency).
