const { verifyToken } = require('../utils/jwt');
const db = require('../db');

/** Verifies the Bearer token and attaches req.user = { sub, storeId, role }.
 * Also re-checks the underlying user's current status — a JWT is only
 * proof of who logged in and when, not that the account is still allowed
 * to. Without this, disabling/removing a user in Users.jsx had no effect
 * on that person's existing session: their token kept working for every
 * request until it naturally expired. Mirrors the same fix in the web
 * backend's middleware/auth.js (that edition also checks an `auditors`
 * table this desktop edition doesn't have — no auditor-marketplace role
 * exists here, it's cloud-only). */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing authorization token' });

  try {
    req.user = verifyToken(token);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  if (['admin', 'manager', 'staff', 'cashier', 'checkout'].includes(req.user.role)) {
    const user = db.prepare('SELECT status FROM users WHERE id = ?').get(req.user.sub);
    if (!user || user.status !== 'active') {
      return res.status(401).json({ error: 'This account is no longer active. Contact your store admin.', code: 'ACCOUNT_DISABLED' });
    }
  }

  next();
}

/** Restrict route to specific roles, e.g. requireRole('super_admin', 'admin') */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

/** Ensures a non-super-admin request is scoped to their own store (defense in depth). */
function scopeToOwnStore(req, res, next) {
  if (req.user.role === 'super_admin') return next();
  const paramStoreId = req.params.storeId;
  if (paramStoreId && paramStoreId !== req.user.storeId) {
    return res.status(403).json({ error: 'Cannot access another store\'s data' });
  }
  next();
}

/**
 * Blocks feature routes for stores that aren't active yet (pending or
 * suspended) — everyone except super_admin must pass through this. The
 * one deliberate exception is the /redeem-code route itself, which must
 * stay reachable so a pending admin can activate their store; that route
 * is registered BEFORE this middleware is applied in routes/stores.js.
 */
function requireActiveStore(req, res, next) {
  if (req.user.role === 'super_admin') return next();
  const store = db.prepare('SELECT subscription_status FROM stores WHERE id = ?').get(req.user.storeId);
  if (!store) return res.status(404).json({ error: 'Store not found' });
  if (store.subscription_status !== 'active') {
    return res.status(403).json({
      error: store.subscription_status === 'suspended'
        ? "This store's subscription is suspended. Contact support."
        : 'This store is not active yet. Activate your subscription with an access code to continue.',
      code: 'STORE_NOT_ACTIVE',
    });
  }
  next();
}

/**
 * Blocks feature routes for a store that's been locked for non-payment —
 * everyone except super_admin must pass through this. Deliberate
 * exceptions are the billing status/claim-payment routes and auth itself,
 * which stay reachable so a locked store's admin can still see why and
 * pay; those routes are registered BEFORE this middleware in
 * routes/stores.js. Returns 423 (Locked) with code STORE_LOCKED — the
 * frontend's axios interceptor (see api/client.js) matches on the `code`
 * field, not the raw status, so this stays in sync with the web backend
 * even if either side's status code choice ever changes.
 */
function requireNotLocked(req, res, next) {
  if (req.user.role === 'super_admin') return next();
  const store = db.prepare('SELECT locked FROM stores WHERE id = ?').get(req.user.storeId);
  if (!store) return res.status(404).json({ error: 'Store not found' });
  if (store.locked) {
    return res.status(423).json({
      error: 'This store is locked due to an unpaid billing charge. Go to Billing to see what\'s owed and confirm payment.',
      code: 'STORE_LOCKED',
    });
  }
  next();
}

/**
 * Alternate auth path for /sync/export and /sync/import: a sync agent
 * (this device talking to a LAN peer, or to the cloud) authenticates with
 * the store's shared sync_key instead of a per-user JWT — proving "I'm a
 * device for the same store", not "I'm a specific logged-in user".
 */
function requireStoreSyncKey(req, res, next) {
  const key = req.headers['x-store-sync-key'];
  const { storeId } = req.params;
  if (!key || !storeId) return res.status(401).json({ error: 'Missing sync key' });
  const store = db.prepare('SELECT sync_key FROM stores WHERE id = ?').get(storeId);
  if (!store || store.sync_key !== key) return res.status(401).json({ error: 'Invalid sync key' });
  req.user = { sub: null, role: 'sync_agent', storeId };
  next();
}

module.exports = { requireAuth, requireRole, scopeToOwnStore, requireActiveStore, requireNotLocked, requireStoreSyncKey };
