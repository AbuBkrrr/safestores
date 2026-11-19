const db = require('../config/db');
const { checkOnsite } = require('../utils/onsite');
const { logActivity } = require('../utils/activityLog');

// Roles that may work away from the shop: the owner and manager (reports,
// approvals), the online market manager (online orders), and booked auditors.
const MAY_WORK_AWAY = new Set(['admin', 'manager', 'marketplace_manager', 'auditor', 'super_admin']);
const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALERT_EVERY_MINUTES = 10;

const MESSAGES = {
  not_on_shop_network: 'You are not on the shop’s internet. Connect to the shop Wi-Fi to do this.',
  location_needed: 'This can only be done in the shop. Connect to the shop Wi-Fi, or allow location so the app can confirm you are in the shop.',
  location_too_vague: 'Your location is not precise enough to confirm you are in the shop. Turn on precise location or connect to the shop Wi-Fi.',
  outside_radius: 'You are outside the shop. This can only be done from inside the shop.',
};

/** Blocks changes by shop-floor staff who are not in the shop, when the owner has switched the lock on. */
async function requireOnSite(req, res, next) {
  if (READ_ONLY.has(req.method) || !req.user || MAY_WORK_AWAY.has(req.user.role)) return next();
  try {
    const { rows } = await db.query(
      'SELECT onsite_lock, onsite_networks, onsite_lat, onsite_lng, onsite_radius_m FROM stores WHERE id = $1', [req.user.storeId]
    );
    const store = rows[0];
    if (!store || !store.onsite_lock) return next();
    const geo = { lat: req.get('x-geo-lat'), lng: req.get('x-geo-lng'), accuracy: req.get('x-geo-accuracy') };
    let result;
    if (isOfflineReplay(req)) {
      // Something done with no internet, being sent now. Judge it by where
      // it was MADE: the location saved with it. Otherwise airplane mode at
      // home, then syncing on the shop Wi-Fi, would get it through.
      if (geo.lat) {
        result = checkOnsite({ ...store, onsite_networks: [] }, geo);
      } else {
        // No location saved with it (location off, or the shop only uses its
        // Wi-Fi). Accept it only from the shop connection, and tell the owner
        // it couldn't be confirmed so they can check it.
        result = checkOnsite({ ...store, onsite_lat: null, onsite_lng: null }, { ip: req.ip });
        if (result.ok) {
          await flagUnverified(req).catch((err) => console.error('offline-sync flag failed:', err.message));
          return next();
        }
      }
    } else {
      result = checkOnsite(store, { ip: req.ip, ...geo });
    }
    if (result.ok) return next();

    // The block stands even if the alert can't be written.
    await alertOwner(req, result).catch((err) => console.error('offsite alert failed:', err.message));
    return res.status(403).json({
      code: 'OFFSITE', reason: result.how, canUseLocation: store.onsite_lat != null && store.onsite_lng != null,
      error: MESSAGES[result.how] || MESSAGES.outside_radius,
    });
  } catch (err) {
    console.error('onsite check failed:', err);
    return res.status(500).json({ error: 'Could not confirm you are in the shop' });
  }
}

function describe(path) {
  if (/^\/orders/.test(path)) return 'ring up a sale';
  if (/^\/(arrivals|invoices|receipt)/.test(path)) return 'record stock arriving';
  if (/^\/movements/.test(path)) return 'move or write off stock';
  if (/^\/handovers/.test(path)) return 'record a stock handover';
  if (/^\/(refunds|returns)/.test(path)) return 'record a refund or return';
  if (/^\/(exit|security)/.test(path)) return 'record an exit check';
  return 'change shop records';
}

/** Every blocked attempt goes in the activity log; the owner gets at most one alert per person per 10 minutes. */
async function alertOwner(req, result) {
  const { storeId, sub: userId } = req.user;
  const { rows: recent } = await db.query(
    `SELECT 1 FROM activity_log WHERE store_id = $1 AND actor_id = $2 AND action = 'offsite_blocked'
       AND created_at > NOW() - make_interval(mins => $3) LIMIT 1`,
    [storeId, userId, ALERT_EVERY_MINUTES]
  );
  await logActivity(req, {
    storeId, action: 'offsite_blocked', entityType: 'request', entityId: `${req.method} ${req.path}`.slice(0, 120),
    details: { reason: result.how, distanceMetres: result.distance ?? null },
  });
  if (recent.length) return;
  const { rows: who } = await db.query('SELECT name, role FROM users WHERE id = $1', [userId]);
  const name = who[0]?.name || 'A staff member';
  const role = (who[0]?.role || req.user.role || '').replace(/_/g, ' ');
  const where = result.distance != null
    ? ` about ${result.distance >= 1000 ? `${(result.distance / 1000).toFixed(1)} km` : `${result.distance} m`} from the shop`
    : ' from outside the shop';
  await db.query(
    `INSERT INTO store_notifications (store_id, type, severity, audience_role, message) VALUES ($1, 'offsite_attempt', 'amber', 'admin', $2)`,
    [storeId, `${name} (${role}) tried to ${describe(req.path)}${where}. It was blocked.`]
  );
}

function isOfflineReplay(req) {
  return req.query?._offlineReplay === 'true' || req.query?._offlineReplay === true;
}

/** An offline action synced from the shop connection with no location: let it in, log it, tell the owner (once per person per 10 minutes). */
async function flagUnverified(req) {
  const { storeId, sub: userId } = req.user;
  const { rows: recent } = await db.query(
    `SELECT 1 FROM activity_log WHERE store_id = $1 AND actor_id = $2 AND action = 'offline_sync_unverified'
       AND created_at > NOW() - make_interval(mins => $3) LIMIT 1`,
    [storeId, userId, ALERT_EVERY_MINUTES]
  );
  await logActivity(req, {
    storeId, action: 'offline_sync_unverified', entityType: 'request', entityId: `${req.method} ${req.path}`.slice(0, 120),
    details: { madeAt: req.get('x-made-at') || null },
  });
  if (recent.length) return;
  const { rows: who } = await db.query('SELECT name, role FROM users WHERE id = $1', [userId]);
  const name = who[0]?.name || 'A staff member';
  const role = (who[0]?.role || req.user.role || '').replace(/_/g, ' ');
  await db.query(
    `INSERT INTO store_notifications (store_id, type, severity, audience_role, message) VALUES ($1, 'offline_sync_unverified', 'amber', 'admin', $2)`,
    [storeId, `${name} (${role}) synced records made with no internet (e.g. to ${describe(req.path)}). The app could not confirm they were made in the shop — check them in the activity log.`]
  );
}

module.exports = { requireOnSite, MAY_WORK_AWAY };
