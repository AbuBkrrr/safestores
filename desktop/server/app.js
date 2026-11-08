const express = require('express');
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

  app.use(express.json({ limit: '5mb' }));
  app.use(morgan('dev'));

  // Uploaded receipt/camera images
  app.use('/uploads', express.static(uploadsDir));

  app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

  app.use('/api/setup', setupRoutes);
  app.use('/api/auth', authRoutes);
  // Readable by any logged-in user (not just super_admin), and deliberately
  // NOT behind requireActiveStore/requireNotLocked — a pending or locked
  // store's admin needs this to know how to pay in the first place.
  app.get('/api/settings/payment-instructions', requireAuth, billingCtrl.getPaymentSettings);
  // Deliberately public (no requireAuth) — a currency code/symbol isn't
  // sensitive, and the public customer Storefront needs this too, not just
  // logged-in admin pages.
  app.get('/api/settings/currency', settingsCtrl.getCurrency);
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
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
