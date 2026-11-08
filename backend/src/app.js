// ------------------------------------------------------------
// Pure Express app — no HTTP server, no Socket.IO, no background jobs.
// Split out from server.js so the exact same request-handling code can
// run two different ways:
//   - server.js: traditional always-on host (Render/Fly/a VPS/your own
//     box) — wraps this in http.createServer, attaches Socket.IO for
//     realtime, starts the billing job loop, listens on a port.
//   - netlify/functions/api.js: Netlify Functions (serverless) — wraps
//     this with serverless-http instead. No realtime there (see that
//     file's header for what that means in practice) and no in-process
//     job loop (see netlify/functions/billing-cron.js for the scheduled
//     equivalent).
// Both are equally supported; which one a given deployment uses is a
// hosting choice, not a code fork.
// ------------------------------------------------------------

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');

const { uploadDir } = require('./middleware/upload');
const { authLimiter, apiLimiter } = require('./middleware/rateLimit');
const { buildCorsOptions } = require('./config/corsOrigins');
const errorMonitoring = require('./utils/errorMonitoring');

errorMonitoring.init(); // safe no-op if SENTRY_DSN isn't set — see that file

const authRoutes = require('./routes/auth');
const superRoutes = require('./routes/super');
const setupRoutes = require('./routes/setup');
const storeRoutes = require('./routes/stores');
const auditorRoutes = require('./routes/auditor');
const marketplaceRoutes = require('./routes/marketplace');
const pushRoutes = require('./routes/push');
const lendingRoutes = require('./routes/lending');
const { requireAuth } = require('./middleware/auth');
const billingCtrl = require('./controllers/billingController');
const settingsCtrl = require('./controllers/settingsController');

function createApp() {
  const app = express();
  const isProd = process.env.NODE_ENV === 'production';

  // Trust the first hop proxy (Render/Railway/Fly/nginx/Netlify/etc.) so
  // req.ip and the rate limiter see the real client IP instead of the
  // proxy's IP.
  app.set('trust proxy', 1);

  app.use(helmet({
    // Uploaded receipt/camera images are served cross-origin to the frontend,
    // so we relax CORP for that path specifically rather than site-wide.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));
  app.use(compression());
  app.use(cors(buildCorsOptions()));
  // The `verify` callback stashes the exact raw bytes on req.rawBody
  // before JSON-parsing them — needed by the Paystack webhook route
  // below to check its HMAC signature, which is computed over the raw
  // body and would not match a re-serialized version of the parsed
  // object (key order/whitespace aren't guaranteed to round-trip).
  app.use(express.json({
    limit: '5mb',
    verify: (req, res, buf) => { req.rawBody = buf; },
  }));
  app.use(morgan(isProd ? 'combined' : 'dev'));

  // General rate limit on all /api routes, tighter limit specifically on auth.
  // On Netlify Functions this still works — rateLimit.js's store just needs
  // to be a shared backing store (e.g. Postgres/Redis) rather than in-memory
  // if you're running multiple function instances; see rateLimit.js's own
  // header for its current store choice.
  app.use('/api', apiLimiter);
  app.use('/api/auth', authLimiter);

  // Serve uploaded receipt/camera images. On Netlify Functions this only
  // serves whatever's in the function's own ephemeral filesystem — fine
  // for local/traditional hosting, but pair with S3-compatible storage
  // (see utils/storage.js) for a serverless deployment, where uploads
  // need to persist across invocations.
  app.use('/uploads', express.static(uploadDir));

  app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

  app.use('/api/auth', authRoutes);
  // SECURITY NOTE: unauthenticated but self-locking — POST /super-admin only
  // succeeds while zero Super Admin accounts exist anywhere, then refuses
  // forever after. This is how a fresh deployment gets its first Super
  // Admin (there is no seed script for one). Complete setup immediately
  // after deploying, before exposing the endpoint publicly if at all avoidable —
  // whoever calls this first, wins.
  app.use('/api/setup', setupRoutes);
  // Readable by any logged-in user (not just super_admin), and deliberately
  // NOT behind requireActiveStore/locked gating — a pending or locked
  // store's admin needs this to know how to pay in the first place.
  app.get('/api/settings/payment-instructions', requireAuth, billingCtrl.getPaymentSettings);
  app.get('/api/settings/currency', settingsCtrl.getCurrency);
  // Digital receipt behind the QR code / link printed on a receipt.
  app.get('/api/public/receipts/:token', require('./controllers/ordersController').publicReceipt);
  app.use('/api/account', require('./routes/account'));
  app.use('/api/super', superRoutes);
  app.use('/api/stores/:storeId', storeRoutes);
  app.use('/api/auditor', auditorRoutes);
  app.use('/api/marketplace', marketplaceRoutes);
  app.use('/api/push', pushRoutes);
  app.use('/api/lending', lendingRoutes);
  // No auth — Paystack calls this directly and doesn't have our JWTs;
  // see paymentWebhookController.js's header for how it's secured instead.
  app.post('/api/webhooks/paystack', require('./controllers/paymentWebhookController').handlePaystackWebhook);

  // 404 handler
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // Reports 4xx/5xx errors to Sentry (safe no-op if not configured) —
  // must come after routes/404, before the final JSON error handler.
  errorMonitoring.attachExpressErrorHandler(app);

  // Central error handler
  // Central error handler. Per Express's own docs on error-handling
  // middleware: if headers were already sent (e.g. a side effect thrown
  // after a successful res.json(), such as a controller's realtime
  // emits), delegate to Express's default handler instead of trying to
  // send a second response — attempting that throws "Cannot set headers
  // after they are sent to the client".
  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
