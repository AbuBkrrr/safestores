const { verifyToken } = require('../utils/jwt');
const db = require('../config/db');

/** Core JWT verification + account-status check, shared by requireAuth and
 * requireAuthOrStoreSyncKey below so the two auth paths can't silently
 * drift apart the way createTicket/addReply's account-status handling
 * once did before this refactor. Returns { ok: true } with req.user set,
 * or { ok: false, status, body } for the caller to respond with directly. */
async function authenticateJwt(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return { ok: false, status: 401, body: { error: 'Missing authorization token' } };

  let user;
  try {
    user = verifyToken(token);
  } catch (err) {
    return { ok: false, status: 401, body: { error: 'Invalid or expired token' } };
  }

  try {
    if (['admin', 'manager', 'staff', 'cashier', 'checkout', 'stock_taker'].includes(user.role)) {
      const { rows } = await db.query('SELECT status FROM users WHERE id = $1', [user.sub]);
      if (!rows[0] || rows[0].status !== 'active') {
        return { ok: false, status: 401, body: { error: 'This account is no longer active. Contact your store admin.', code: 'ACCOUNT_DISABLED' } };
      }
    } else if (user.role === 'auditor') {
      const { rows } = await db.query('SELECT status FROM auditors WHERE id = $1', [user.sub]);
      if (!rows[0] || rows[0].status !== 'active') {
        return { ok: false, status: 401, body: { error: 'This auditor account is no longer active.', code: 'ACCOUNT_DISABLED' } };
      }
    }
  } catch (err) {
    console.error('authenticateJwt account-status check failed:', err.message);
    return { ok: false, status: 500, body: { error: 'Failed to verify account status' } };
  }

  req.user = user;
  return { ok: true };
}

/** Verifies the Bearer token and attaches req.user = { sub, storeId, role }.
 * Also re-checks the underlying account's current status for role types
 * that have a revocation concept (users.status, auditors.status) — a JWT
 * is only proof of who logged in and when, not that the account is still
 * allowed to. Without this, disabling/removing a user in Users.jsx (or a
 * Super Admin suspending an auditor) had no effect on that person's
 * existing session: their token kept working for every request until it
 * naturally expired (which, in production, means up to JWT_EXPIRES_IN —
 * commonly several days). super_admins and customers have no status/
 * suspension concept yet, so they're intentionally not checked here;
 * add the same pattern if/when that changes for either. */
async function requireAuth(req, res, next) {
  const result = await authenticateJwt(req);
  if (!result.ok) return res.status(result.status).json(result.body);
  next();
}

/** Like requireAuth, but a missing/invalid token is fine — req.user is just
 * left undefined instead of rejecting. For guest checkout: a shopper with
 * an account gets req.user.sub set (their order attributes to them), a
 * guest doesn't (their order needs guest contact details in the body
 * instead — see marketplaceController.placeOrder). */
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next();
  try {
    req.user = verifyToken(token);
  } catch (err) {
    // Invalid/expired token on an optional-auth route — proceed as a guest
    // rather than rejecting outright; the request itself is still valid.
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
 * suspended), or that are locked for non-payment — everyone except
 * super_admin must pass through this. The deliberate exceptions are the
 * /redeem-code and /billing/status routes, which must stay reachable so a
 * pending admin can activate their store, or a locked store can still see
 * why and pay; both are registered BEFORE this middleware in routes/stores.js.
 */
async function requireActiveStore(req, res, next) {
  if (req.user.role === 'super_admin') return next();
  try {
    const { rows } = await db.query('SELECT subscription_status, locked FROM stores WHERE id = $1', [req.user.storeId]);
    const store = rows[0];
    if (!store) return res.status(404).json({ error: 'Store not found' });
    if (store.subscription_status !== 'active') {
      return res.status(403).json({
        error: store.subscription_status === 'suspended'
          ? "This store's subscription is suspended. Contact support."
          : 'This store is not active yet. Activate your subscription with an access code to continue.',
        code: 'STORE_NOT_ACTIVE',
      });
    }
    if (store.locked) {
      // 423 (Locked) — matches the desktop edition and the frontend's axios
      // interceptor. This used to be 402 here, which meant a locked web
      // store's user got raw failed API calls instead of an auto-redirect
      // to Billing. The interceptor actually keys off `code`, not the raw
      // status, so this stays correct even if either side's code changes.
      return res.status(423).json({
        error: 'This store is locked due to an unpaid billing charge. Go to Billing to see what\'s owed and confirm payment.',
        code: 'STORE_LOCKED',
      });
    }
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to verify store status' });
  }
}

/**
 * Alternate auth path for the /sync/export endpoint: a sync agent (the
 * Electron LAN relay talking to a peer, or to the cloud) authenticates
 * with the store's shared sync_key instead of a per-user JWT — the point
 * of this endpoint is proving "I'm a device for the same store", not
 * "I'm a specific logged-in user". req.user is set to a minimal shape so
 * downstream code (scopeToOwnStore etc.) still works.
 */
async function requireStoreSyncKey(req, res, next) {
  const key = req.headers['x-store-sync-key'];
  const { storeId } = req.params;
  if (!key || !storeId) return res.status(401).json({ error: 'Missing sync key' });
  try {
    const { rows } = await db.query('SELECT sync_key FROM stores WHERE id = $1', [storeId]);
    if (!rows[0] || rows[0].sync_key !== key) return res.status(401).json({ error: 'Invalid sync key' });
    req.user = { sub: null, role: 'sync_agent', storeId };
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to verify sync key' });
  }
}

/**
 * For routes the desktop edition reaches via its store-wide sync key
 * (proxying on behalf of whichever admin is using the app locally,
 * exactly like requireStoreSyncKey above) but that a browser also needs
 * to reach directly with a normal per-user JWT (e.g. Support, since a web
 * store admin uses it too). Tries the sync key first — a store can only
 * ever authenticate as itself that way, so this doesn't need scopeToOwnStore
 * — then falls back to full JWT verification + the given role check.
 * Register these routes BEFORE the router's blanket `router.use(requireAuth,
 * scopeToOwnStore)`, same as requireStoreSyncKey's own routes, so that
 * global middleware doesn't reject the sync-key path before it gets here.
 */
function requireAuthOrStoreSyncKey(...roles) {
  return async (req, res, next) => {
    const key = req.headers['x-store-sync-key'];
    const { storeId } = req.params;
    if (key) {
      if (!storeId) return res.status(401).json({ error: 'Missing sync key' });
      try {
        const { rows } = await db.query('SELECT sync_key FROM stores WHERE id = $1', [storeId]);
        if (!rows[0] || rows[0].sync_key !== key) return res.status(401).json({ error: 'Invalid sync key' });
        req.user = { sub: null, role: 'sync_agent', storeId };
        return next();
      } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to verify sync key' });
      }
    }

    const result = await authenticateJwt(req);
    if (!result.ok) return res.status(result.status).json(result.body);
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}

/**
 * Shelf-audit access is no longer a standing admin feature — it's gated to
 * whether the store currently has an active (accepted/in_progress) audit
 * engagement. Admins request one from the Auditor tab; once an auditor
 * accepts, this store's admin + any stock-takers that auditor invited can
 * use the shelf-audit endpoints until the engagement is completed/cancelled.
 */
// Only EXTERNAL counters (an engaged 'auditor' and the temporary
// 'stock_taker's they invite) are time-boxed to an active engagement. A
// store's own admin/manager/staff can always run their own shelf audits —
// gating them too made Shelf Audit unusable for any store that had never
// hired an outside auditor.
const ENGAGEMENT_GATED_ROLES = new Set(['auditor', 'stock_taker']);

async function requireActiveEngagement(req, res, next) {
  if (!ENGAGEMENT_GATED_ROLES.has(req.user.role)) return next();
  try {
    const { rows } = await db.query(
      `SELECT id FROM audit_engagements WHERE store_id = $1 AND status IN ('accepted','in_progress') LIMIT 1`,
      [req.user.storeId]
    );
    if (!rows[0]) {
      return res.status(403).json({
        error: 'No active audit engagement for this store. Request one from the Auditor tab.',
        code: 'NO_ACTIVE_ENGAGEMENT',
      });
    }
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to verify audit engagement' });
  }
}

/**
 * Authenticates a lending partner's server-to-server API calls (not a
 * store or a user) — a bearer API key, verified against a bcrypt hash
 * (never stored in plaintext, same principle as a user password). Only
 * an 'active' partner can authenticate; 'pending'/'suspended' are
 * rejected even with a technically-correct key, so a super admin
 * suspending a partner takes effect immediately without having to
 * separately revoke/rotate the key.
 */
async function requireLendingPartnerKey(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing API key' });
  const key = auth.slice(7);
  try {
    const bcrypt = require('bcryptjs');
    const { rows } = await db.query(`SELECT * FROM lending_partners WHERE status = 'active'`);
    const partner = (await Promise.all(rows.map(async (p) => ((await bcrypt.compare(key, p.api_key_hash)) ? p : null))))
      .find(Boolean);
    if (!partner) return res.status(401).json({ error: 'Invalid or inactive API key' });
    req.lendingPartner = partner;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to verify API key' });
  }
}

module.exports = { requireAuth, optionalAuth, requireRole, scopeToOwnStore, requireActiveStore, requireStoreSyncKey, requireAuthOrStoreSyncKey, requireActiveEngagement, requireLendingPartnerKey };
