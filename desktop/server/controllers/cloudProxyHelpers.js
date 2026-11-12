// ------------------------------------------------------------
// Shared setup for the handful of desktop controllers that proxy to the
// cloud service (marketplace, support tickets, audit-engagements) using
// the store's sync_key rather than a user session — desktop has no cloud
// login to offer. See syncAgent.js's cloudEnabled config: these are the
// only features that need it turned on at all; every other feature in
// this app runs fully offline regardless.
// ------------------------------------------------------------

const db = require('../db');
const { loadConfig } = require('../syncAgent');

function getStoreRow() {
  return db.prepare('SELECT id, sync_key FROM stores LIMIT 1').get();
}

/** Returns { baseUrl, storeId, headers } for a cloud call, or writes an
 * error response and returns null if cloud sync isn't configured. */
function cloudClientOrError(res) {
  const config = loadConfig();
  if (!config.cloudEnabled || !config.cloudUrl) {
    res.status(400).json({ error: 'Enable cloud sync in Settings to use this feature.' });
    return null;
  }
  const store = getStoreRow();
  if (!store) {
    res.status(400).json({ error: 'Store not set up yet.' });
    return null;
  }
  return {
    baseUrl: config.cloudUrl.replace(/\/$/, ''),
    storeId: store.id,
    headers: { 'X-Store-Sync-Key': store.sync_key },
  };
}

/** The local admin's display name, for attributing device-proxied cloud actions. */
function currentUserName(req) {
  if (!req.user?.sub) return 'Store user';
  const row = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.sub);
  return row?.name || 'Store user';
}

function forwardError(err, res) {
  if (err.response) return res.status(err.response.status).json(err.response.data);
  console.error('[cloud proxy] request failed:', err.message);
  res.status(502).json({ error: 'Could not reach the cloud service. Check your connection and try again.' });
}

module.exports = { cloudClientOrError, currentUserName, forwardError };
