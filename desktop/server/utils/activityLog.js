// Desktop twin of backend/src/utils/activityLog.js — synchronous SQLite.
// Never throws: a logging failure must not break the action being logged.
const crypto = require('crypto');
const db = require('../db');

function logActivity(req, { storeId, action, entityType = null, entityId = null, details = {} }) {
  try {
    const u = req?.user || {};
    const name = u.sub
      ? (db.prepare('SELECT name FROM users WHERE id = ?').get(u.sub)?.name
        || db.prepare('SELECT name FROM super_admins WHERE id = ?').get(u.sub)?.name || null)
      : null;
    db.prepare(
      `INSERT INTO activity_log (id, store_id, actor_id, actor_role, actor_name, action, entity_type, entity_id, details, ip)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      crypto.randomUUID(), storeId === undefined ? (u.storeId || null) : storeId,
      u.sub || null, u.role || null, name, action, entityType,
      entityId == null ? null : String(entityId), JSON.stringify(details || {}), (req?.ip || '').slice(0, 64) || null
    );
  } catch (err) {
    console.error(`activity log write failed (${action}):`, err.message);
  }
}

module.exports = { logActivity };
