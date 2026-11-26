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
// Must load before any route is defined: async handler failures reach the error handler.
const { publicError } = require('./utils/asyncErrors');
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
  // How many proxies stand between the visitor and this app. Behind Caddy
  // (or the host's nginx) AND the frontend's nginx there are 2; the rate
  // limits key on the visitor's real address only when this is right —
  // too low and every visitor looks like the proxy (one shared limit);
  // too high and a visitor could fake their address.
  app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

  app.use(helmet({
    // Uploaded receipt/camera images are served cross-origin to the frontend,
    // so we relax CORP for that path specifically rather than site-wide.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));
  app.use(compression());
  // Marketing: the public website (its own domain) reports page opens and
  // demo requests here, so these few routes accept any origin (no cookies,
  // no login) and are registered before the app-wide CORS rule.
  const mk = require('./controllers/marketingController');
  const mkCors = cors({ origin: true, credentials: false });
  const mkLimit = require('express-rate-limit')({ windowMs: 10 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
  const mkJson = express.json({ limit: '20kb', type: ['application/json', 'text/plain'] });
  app.options('/api/m/*', mkCors);
  app.post('/api/m/open', mkCors, mkLimit, mkJson, mk.recordOpen);
  app.post('/api/m/lead', mkCors, mkLimit, mkJson, mk.recordLead);
  app.get('/api/m/unsubscribe/:token', mk.unsubscribe);
  // The website checks which app address is live before pointing its links at it.
  app.get('/api/m/ping', mkCors, (req, res) => res.json({ ok: true }));
  const chat = require('./controllers/liveChatController');
  const chatLimit = require('express-rate-limit')({ windowMs: 10 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false });
  const chatReadLimit = require('express-rate-limit')({ windowMs: 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false });
  app.post('/api/m/chat', mkCors, chatLimit, mkJson, require('./middleware/auth').optionalAuth, chat.send);
  app.get('/api/m/chat/:token', mkCors, chatReadLimit, chat.read);
  app.get('/go/:code', mk.go);
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
  app.use('/uploads', express.static(uploadDir, {
    setHeaders: (res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    },
  }));

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
  const publicCtrl = require('./controllers/publicController');
  app.get('/api/public/marketplace-orders/:token', publicCtrl.trackOrder);
  // ICE servers for support calls: free public STUN, plus your own TURN
  // server when set (needed when either side is behind a strict mobile network).
  app.get('/api/rtc/ice', require('./middleware/auth').requireAuth, (req, res) => {
    const ice = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
    if (process.env.TURN_URL) ice.push({ urls: process.env.TURN_URL.split(',').map((u) => u.trim()), username: process.env.TURN_USERNAME || '', credential: process.env.TURN_PASSWORD || '' });
    res.json({ iceServers: ice });
  });
  const orderChatLimit = require('express-rate-limit')({ windowMs: 10 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
  app.get('/api/public/marketplace-orders/:token/chat', publicCtrl.orderChat);
  app.post('/api/public/marketplace-orders/:token/chat', orderChatLimit, require('./utils/storage').upload.single('photo'), publicCtrl.orderChatSend);
  app.post('/api/public/marketplace-orders/:token/payment-sent', require('express-rate-limit')({ windowMs: 10 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false }), publicCtrl.paymentSent);
  const { shopParam } = require('./utils/shopSlug');
  app.get('/api/public/stores/:storeId', (req, res, next) => shopParam(req, res, next, req.params.storeId), publicCtrl.storeInfo);
  app.get('/share/shop/:storeId', publicCtrl.shareShop);
  // Custom domains: Caddy's on-demand TLS "ask" (200 = issue a certificate)…
  app.get('/api/public/domain-check', async (req, res) => {
    const store = await require('./utils/customDomain').storeForDomain(req.query.domain);
    res.status(store ? 200 : 404).end();
  });
  // …and the frontend, to know which shop a custom domain belongs to.
  app.get('/api/public/by-domain/:host', async (req, res) => {
    const store = await require('./utils/customDomain').storeForDomain(req.params.host);
    if (!store) return res.status(404).json({ error: 'No shop on this domain' });
    res.json({ storeId: store.id, shopSlug: store.shop_slug });
  });
  app.get('/sitemap.xml', publicCtrl.sitemap);
  app.get('/robots.txt', publicCtrl.robots);
  // A store's own apps (sign-up popup polls these; the token is the store's secret link).
  app.get('/api/store-apps/:token', require('./controllers/storeAppsController').status);
  app.get('/api/store-apps/:token/:platform', require('./controllers/storeAppsController').download);
  app.use('/api/account', require('./routes/account'));
  app.use('/api/super', superRoutes);
  app.use('/api/stores/:storeId', storeRoutes);
  app.use('/api/auditor', auditorRoutes);
  app.use('/api/marketplace', marketplaceRoutes);
  app.use('/api/push', pushRoutes);
  app.use('/api/lending', lendingRoutes);
  app.use('/api/partner', require('./routes/partner'));
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
    const { status, body } = publicError(err);
    res.status(status).json(body);
  });

  return app;
}

module.exports = { createApp };
