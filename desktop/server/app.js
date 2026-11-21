const express = require('express');
// Must load before any route is defined: async handler failures reach the error handler.
const { publicError } = require('./utils/asyncErrors');
const morgan = require('morgan');
const path = require('path');
const { uploadsDir } = require('./db');
const errorMonitoring = require('./errorMonitoring');

errorMonitoring.init(); // safe no-op if SENTRY_DSN isn't set — see that file

const setupRoutes = require('./routes/setup');
const authRoutes = require('./routes/auth');
const superRoutes = require('./routes/super');
const storeRoutes = require('./routes/stores');
const { requireAuth } = require('./middleware/auth');
const billingCtrl = require('./controllers/billingController');
const settingsCtrl = require('./controllers/settingsController');

function createApp() {
  const app = express();

  // Basic browser protections for every device on the shop network.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.use(express.json({ limit: '5mb' }));
  app.use(morgan('dev'));

  // Uploaded receipt/camera images
  app.use('/uploads', express.static(uploadsDir, {
    setHeaders: (res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    },
  }));

  app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

  // First-time setup (connecting to the store, creating the first account)
  // can only be done on the shop computer itself, never from another
  // device on the Wi-Fi.
  app.use('/api/setup', (req, res, next) => {
    if (req.method === 'GET' || require('./middleware/limits').isLocal(req)) return next();
    res.status(403).json({ error: 'Set up the store on the shop computer itself.' });
  }, setupRoutes);
  // Password guessing from other devices on the Wi-Fi is slowed down.
  app.use('/api/auth', require('./middleware/limits').authLimiter, authRoutes);
  app.use('/api/account', require('./middleware/limits').authLimiter);
  // Readable by any logged-in user (not just super_admin), and deliberately
  // NOT behind requireActiveStore/requireNotLocked — a pending or locked
  // store's admin needs this to know how to pay in the first place.
  app.get('/api/settings/payment-instructions', requireAuth, billingCtrl.getPaymentSettings);
  // Deliberately public (no requireAuth) — a currency code/symbol isn't
  // sensitive, and the public customer Storefront needs this too, not just
  // logged-in admin pages.
  app.get('/api/settings/currency', settingsCtrl.getCurrency);
  // Wi-Fi / network receipt printers, for every device in the shop.
  app.post('/api/print/network', requireAuth, require('./controllers/printController').printNetwork);
  app.get('/api/public/receipts/:token', require('./controllers/ordersController').publicReceipt);
  app.use('/api/account', require('./routes/account'));
  app.use('/api/super', superRoutes);
  app.use('/api/stores/:storeId', storeRoutes);

  // Serve the built frontend (produced by `cd frontend && npm run build`,
  // then copied into desktop/frontend-dist by the desktop build script).
  const frontendDist = path.join(__dirname, '..', 'frontend-dist');
  app.use(express.static(frontendDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
    res.sendFile(path.join(frontendDist, 'index.html'));
  });

  // 404 for unmatched API routes
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  errorMonitoring.attachExpressErrorHandler(app);

  // Central error handler. Per Express's own docs on error-handling
  // middleware: if headers were already sent (e.g. a side effect thrown
  // after a successful res.json(), such as inventoryController.js's
  // realtime emits), delegate to Express's default handler instead of
  // trying to send a second response — attempting that throws "Cannot
  // set headers after they are sent to the client".
  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return next(err);
    const { status, body } = publicError(err);
    res.status(status).json(body);
  });

  return app;
}

module.exports = { createApp };
