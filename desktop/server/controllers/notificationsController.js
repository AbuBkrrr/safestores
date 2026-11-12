const db = require('../db');

// GET /api/super/notifications?unreadOnly=true
function listNotifications(req, res) {
  const { unreadOnly } = req.query;
  const rows = unreadOnly === 'true'
    ? db.prepare(`SELECT * FROM notifications WHERE read_at IS NULL ORDER BY created_at DESC LIMIT 100`).all()
    : db.prepare(`SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100`).all();
  res.json(rows);
}

// GET /api/super/notifications/unread-count
function unreadCount(req, res) {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM notifications WHERE read_at IS NULL`).get();
  res.json({ count: row.count });
}

// PATCH /api/super/notifications/:id/dismiss
function dismissNotification(req, res) {
  const { id } = req.params;
  const info = db.prepare(`UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Notification not found' });
  res.json({ id, dismissed: true });
}

// PATCH /api/super/notifications/dismiss-all
function dismissAll(req, res) {
  db.prepare(`UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE read_at IS NULL`).run();
  res.json({ dismissed: true });
}

module.exports = { listNotifications, unreadCount, dismissNotification, dismissAll };
