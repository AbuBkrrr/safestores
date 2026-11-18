// ------------------------------------------------------------
// Error monitoring (Sentry). Wired here rather than calling the SDK
// directly from app.js/server.js so there's exactly one place that
// decides whether monitoring is active at all — every call site below is
// a safe no-op when SENTRY_DSN isn't set, which keeps local dev and the
// test suite completely unaffected without needing a fake DSN anywhere.
//
// Setup: set SENTRY_DSN in the environment (get one free at sentry.io —
// the free tier is generous enough for a project this size). Nothing
// else to configure; leaving it unset just means no error monitoring,
// not a crash.
// ------------------------------------------------------------

const Sentry = require('@sentry/node');

let enabled = false;

function init() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log('[error-monitoring] SENTRY_DSN not set — error monitoring disabled. See src/utils/errorMonitoring.js.');
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    // Release tracking helps tell "this error started after deploy X" —
    // falls back to undefined (Sentry just won't group by release) if
    // this isn't set, rather than failing to init.
    release: process.env.RELEASE_VERSION || process.env.npm_package_version,
    tracesSampleRate: 0.1, // light performance tracing; errors are always captured regardless of this
    beforeSend(event) {
      // Never let request bodies (which can contain passwords, payment
      // references, invite codes) leave the server. Sentry captures
      // stack traces and request metadata by default, not raw bodies —
      // this is an extra guard, not undoing something risky by default.
      if (event.request) delete event.request.data;
      return event;
    },
  });
  enabled = true;
  console.log('[error-monitoring] Sentry initialized.');
}

/** Attach AFTER all routes, BEFORE your own final error-handling middleware. */
function attachExpressErrorHandler(app) {
  if (!enabled) return;
  Sentry.setupExpressErrorHandler(app);
}

/** For errors caught outside Express's request/response cycle (background jobs, startup). */
function captureException(err, context) {
  if (!enabled) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

module.exports = { init, attachExpressErrorHandler, captureException, isEnabled: () => enabled };
