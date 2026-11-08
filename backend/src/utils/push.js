// ------------------------------------------------------------
// Push notifications (Android/iOS mobile edition) via Firebase Cloud
// Messaging. Companion to mobile/'s @capacitor/push-notifications wiring
// and migrations/023_push_notifications.sql.
//
// SETUP (required before this does anything):
//   1. Create a Firebase project at https://console.firebase.google.com
//      (free tier is fine — FCM has no usage cost).
//   2. Add an Android app to it with package name com.safestores.app
//      (must match capacitor.config.json's appId), download the
//      generated google-services.json, and place it at
//      mobile/android/app/google-services.json — the Android build
//      already auto-detects and applies it (see app/build.gradle).
//   3. Project Settings → Service Accounts → Generate new private key.
//      That JSON is what this file needs — set FIREBASE_SERVICE_ACCOUNT
//      in .env to its content (minified to one line), or
//      FIREBASE_SERVICE_ACCOUNT_PATH to a file path if you'd rather not
//      put the whole JSON in an env var.
//
// If neither is set, sendPush() logs a warning once and resolves without
// throwing — same pattern as mailer.js — so a deployment that hasn't set
// up Firebase yet keeps working, it just skips the push (in-app/email
// notifications still fire normally).
// ------------------------------------------------------------

const db = require('../config/db');

let admin;
try {
  admin = require('firebase-admin');
} catch {
  admin = null; // package not installed — sendPush() will no-op below
}

let app = null;
function getApp() {
  if (app || !admin) return app;

  let credentialJson = null;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    credentialJson = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    credentialJson = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
  }
  if (!credentialJson) return null;

  app = admin.initializeApp({ credential: admin.credential.cert(credentialJson) });
  return app;
}

const isConfigured = () => !!getApp();
let warnedOnce = false;

/**
 * Sends a push notification to every device a user has registered.
 * Silently prunes tokens FCM reports as no-longer-valid (app uninstalled,
 * token rotated without re-registering) so device_push_tokens doesn't
 * accumulate dead rows forever.
 *
 * @param {string} userId
 * @param {{ title: string, body: string, data?: Record<string,string> }} notification
 */
async function sendPushToUser(userId, { title, body, data }) {
  if (!isConfigured()) {
    if (!warnedOnce) {
      console.warn(
        '⚠️  Push notifications: not configured (no FIREBASE_SERVICE_ACCOUNT[_PATH] set). ' +
        'Mobile push is skipped — in-app/email notifications still work normally. ' +
        'See src/utils/push.js\'s header for setup steps.'
      );
      warnedOnce = true;
    }
    return;
  }

  const { rows: tokens } = await db.query('SELECT id, token FROM device_push_tokens WHERE user_id = $1', [userId]);
  if (tokens.length === 0) return;

  const message = {
    notification: { title, body },
    data: data || {},
    tokens: tokens.map((t) => t.token),
  };

  try {
    const result = await admin.messaging(app).sendEachForMulticast(message);
    const deadTokenIds = [];
    result.responses.forEach((r, i) => {
      if (!r.success && ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(r.error?.code)) {
        deadTokenIds.push(tokens[i].id);
      }
    });
    if (deadTokenIds.length > 0) {
      await db.query('DELETE FROM device_push_tokens WHERE id = ANY($1)', [deadTokenIds]);
    }
  } catch (err) {
    console.error('Push send failed:', err.message);
  }
}

/** Same as sendPushToUser, but to every device registered to anyone at a store — used for store-wide alerts (new marketplace order, etc.) rather than a specific person. */
async function sendPushToStore(storeId, notification) {
  if (!isConfigured()) return sendPushToUser(null, notification); // triggers the same one-time warning path, no-ops otherwise
  const { rows: userIds } = await db.query('SELECT DISTINCT user_id FROM device_push_tokens WHERE store_id = $1', [storeId]);
  await Promise.all(userIds.map((r) => sendPushToUser(r.user_id, notification)));
}

module.exports = { sendPushToUser, sendPushToStore, isConfigured };
