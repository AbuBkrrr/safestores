// FRONTEND_URL can be a single origin ("https://app.example.com") or a
// comma-separated list ("https://app.example.com,https://admin.example.com")
// so the same backend can serve a web app and, later, a desktop/mobile
// client hitting it from a different origin (e.g. Capacitor's
// capacitor://localhost, or Electron's file:// origin — Electron's own
// requests aren't subject to CORS at all, but this keeps the list flexible).
//
// In development, with FRONTEND_URL unset, we fall back to reflecting
// whatever origin asked (effectively "allow all") since that's what local
// dev across random ports needs. In production this must be set explicitly —
// validateEnv.js already refuses to boot without it.
function buildCorsOptions() {
  const raw = process.env.FRONTEND_URL;
  if (!raw) {
    return { origin: true, credentials: true }; // dev fallback: reflect origin
  }
  const allowed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return {
    origin(origin, callback) {
      // Non-browser clients (curl, mobile native shells, server-to-server)
      // send no Origin header at all — allow those through.
      if (!origin || allowed.includes(origin)) return callback(null, true);
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  };
}

module.exports = { buildCorsOptions };
