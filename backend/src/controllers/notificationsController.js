const db = require('../config/db');

// GET /api/super/notifications?unreadOnly=true
async function listNotifications(req, res) {
  const { unreadOnly } = req.query;
  const { rows } = await db.query(
    unreadOnly === 'true'
      ? `SELECT * FROM notifications WHERE read_at IS NULL ORDER BY created_at DESC LIMIT 100`
      : `SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100`
  );
  res.json(rows);
}

// GET /api/super/notifications/unread-count
async function unreadCount(req, res) {
  const { rows } = await db.query(`SELECT COUNT(*) AS count FROM notifications WHERE read_at IS NULL`);
  res.json({ count: Number(rows[0].count) });
}

// PATCH /api/super/notifications/:id/dismiss
async function dismissNotification(req, res) {
  const { id } = req.params;
  const { rows } = await db.query(`UPDATE notifications SET read_at = now() WHERE id = $1 RETURNING id`, [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Notification not found' });
  res.json({ id, dismissed: true });
}

// PATCH /api/super/notifications/dismiss-all
async function dismissAll(req, res) {
  await db.query(`UPDATE notifications SET read_at = now() WHERE read_at IS NULL`);
  res.json({ dismissed: true });
}

module.exports = { listNotifications, unreadCount, dismissNotification, dismissAll };
