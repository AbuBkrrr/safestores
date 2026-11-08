// ------------------------------------------------------------
// Store-level notifications (recount alerts, PO auto-generation, etc.) for
// the standalone web edition. Postgres-flavored twin of
// desktop/server/controllers/storeNotificationsController.js.
// ------------------------------------------------------------

const db = require('../config/db');

// GET /api/stores/:storeId/notifications
// Admins see every store-wide (audience_role='admin') notification;
// anyone else sees only notifications addressed to them personally
// (e.g. a stocktaker's recount alerts).
async function list(req, res) {
  const { storeId } = req.params;
  const { rows } = req.user.role === 'admin'
    ? await db.query(
        `SELECT * FROM store_notifications WHERE store_id = $1 AND (audience_role = 'admin' OR user_id = $2)
         ORDER BY created_at DESC LIMIT 200`,
        [storeId, req.user.sub]
      )
    : await db.query(
        `SELECT * FROM store_notifications WHERE store_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 200`,
        [storeId, req.user.sub]
      );

  const unreadCount = rows.filter((r) => r.status === 'unread').length;
  res.json({ notifications: rows, unreadCount });
}

// PATCH /api/stores/:storeId/notifications/:id/read
async function markRead(req, res) {
  const { id } = req.params;
  const { rows } = await db.query(`UPDATE store_notifications SET status = 'read' WHERE id = $1 RETURNING *`, [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Notification not found' });
  res.json(rows[0]);
}

module.exports = { list, markRead };
