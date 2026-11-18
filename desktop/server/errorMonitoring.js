// ------------------------------------------------------------
// Error monitoring (Sentry) for the desktop edition. Same reasoning as
// backend/src/utils/errorMonitoring.js — a safe no-op when SENTRY_DSN
// isn't set, so local dev and the test suite are unaffected.
//
// Setup: unlike the cloud backend (one .env per deployment), a desktop
// app ships as one build to every store that installs it — there's no
// per-install secret to configure. The standard practice for desktop/
// mobile apps (per Sentry's own guidance) is to bake the DSN into the
// build itself; a Sentry DSN identifies which project errors belong to,
// it isn't a secret credential the way an API key is. Set SENTRY_DSN as
// a build-time environment variable before running `npm run dist` (or
// wire it into electron-builder's extraMetadata) — it'll be read here at
// runtime via process.env exactly like the backend does.
// ------------------------------------------------------------

const Sentry = require('@sentry/node');

let enabled = false;

function init() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log('[error-monitoring] SENTRY_DSN not set — error monitoring disabled. See server/errorMonitoring.js.');
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'production',
    release: process.env.RELEASE_VERSION || require('../package.json').version,
    tracesSampleRate: 0.1,
    beforeSend(event) {
      if (event.request) delete event.request.data; // never send raw request bodies (passwords, payment refs)
      return event;
    },
  });
  enabled = true;
  console.log('[error-monitoring] Sentry initialized.');
}

/** Attach AFTER all routes, BEFORE the app's own final error-handling middleware. */
function attachExpressErrorHandler(app) {
  if (!enabled) return;
  Sentry.setupExpressErrorHandler(app);
}

/** For errors outside Express's request/response cycle — background jobs, the Electron main process itself. */
function captureException(err, context) {
  if (!enabled) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

module.exports = { init, attachExpressErrorHandler, captureException, isEnabled: () => enabled };
