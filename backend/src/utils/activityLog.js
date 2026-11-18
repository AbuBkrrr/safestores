// ------------------------------------------------------------
// Activity log — a durable "who did what, when" record for actions that
// matter to an owner or an auditor: price changes, refunds, discounts,
// payments confirmed, users disabled, security changes. Never throws:
// a logging failure must not break the action being logged.
// ------------------------------------------------------------
const db = require('../config/db');

async function logActivity(req, { storeId, action, entityType = null, entityId = null, details = {} }, client = db) {
  try {
    const u = req?.user || {};
    await client.query(
      `INSERT INTO activity_log (store_id, actor_id, actor_role, actor_name, action, entity_type, entity_id, details, ip)
       VALUES ($1,$2,$3,COALESCE($4,(SELECT name FROM users WHERE id = $2),(SELECT name FROM super_admins WHERE id = $2)),$5,$6,$7,$8,$9)`,
      [
        storeId === undefined ? (u.storeId || null) : storeId,
        u.sub || null, u.role || null, u.name || null,
        action, entityType, entityId == null ? null : String(entityId),
        JSON.stringify(details || {}), (req?.ip || '').slice(0, 64) || null,
      ]
    );
  } catch (err) {
    console.error(`activity log write failed (${action}):`, err.message);
  }
}

module.exports = { logActivity };
