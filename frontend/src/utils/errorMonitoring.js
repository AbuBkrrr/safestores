// ------------------------------------------------------------
// Error monitoring (Sentry) for the frontend. Same reasoning as both
// backends' errorMonitoring.js — a safe no-op when no DSN is configured,
// so local dev and the test suite are unaffected.
//
// Setup: Vite only exposes env vars prefixed VITE_ to client code (this
// is a Vite security feature, not a Sentry requirement — it stops
// accidentally bundling server secrets into a public JS file). Set
// VITE_SENTRY_DSN at BUILD time (it's baked into the bundle, same as any
// other VITE_ var — see vite.config.js's dev proxy and the various
// VITE_API_URL usages elsewhere in this codebase for the same pattern).
// A Sentry DSN is safe to ship in a public bundle — it identifies which
// project errors belong to, it isn't a secret credential.
// ------------------------------------------------------------

import * as Sentry from '@sentry/react';

let enabled = false;

export function init() {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) {
    console.log('[error-monitoring] VITE_SENTRY_DSN not set — error monitoring disabled. See src/utils/errorMonitoring.js.');
    return;
  }
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0.1,
    beforeSend(event) {
      // Never send localStorage/request contents (auth tokens, cached
      // offline data) — Sentry's browser SDK doesn't capture these by
      // default, this is an extra guard against a future integration
      // accidentally turning one on.
      delete event.request;
      return event;
    },
  });
  enabled = true;
  console.log('[error-monitoring] Sentry initialized.');
}

export function captureException(err, context) {
  if (!enabled) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

export const ErrorBoundary = Sentry.ErrorBoundary;
export const isEnabled = () => enabled;
