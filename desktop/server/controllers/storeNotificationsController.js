const db = require('../db');

// GET /stores/:storeId/notifications
// Admins see every store-wide (audience_role='admin') notification;
// anyone else sees only notifications addressed to them personally
// (e.g. a stocktaker's recount alerts).
function list(req, res) {
  const { storeId } = req.params;
  const rows = req.user.role === 'admin'
    ? db.prepare(
        `SELECT * FROM store_notifications WHERE store_id = ? AND (audience_role = 'admin' OR user_id = ?)
         ORDER BY created_at DESC LIMIT 200`
      ).all(storeId, req.user.sub)
    : db.prepare(
        `SELECT * FROM store_notifications WHERE store_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 200`
      ).all(storeId, req.user.sub);

  const unreadCount = rows.filter((r) => r.status === 'unread').length;
  res.json({ notifications: rows, unreadCount });
}

// PATCH /stores/:storeId/notifications/:id/read
function markRead(req, res) {
  const { id } = req.params;
  const result = db.prepare(`UPDATE store_notifications SET status = 'read' WHERE id = ?`).run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'Notification not found' });
  res.json(db.prepare('SELECT * FROM store_notifications WHERE id = ?').get(id));
}

module.exports = { list, markRead };
