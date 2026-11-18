// ------------------------------------------------------------
// Push token registration — called by the mobile app (see
// mobile/www's push-notifications init module) once a user is logged in
// and has granted notification permission.
// ------------------------------------------------------------

const db = require('../config/db');

// POST /api/push/register   { token, platform? }
async function registerToken(req, res) {
  const { token, platform } = req.body;
  if (!token) return res.status(400).json({ error: 'token is required' });

  await db.query(
    `INSERT INTO device_push_tokens (user_id, store_id, token, platform)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (token) DO UPDATE SET user_id = $1, store_id = $2, platform = $4, last_seen_at = now()`,
    [req.user.sub, req.user.storeId || null, token, platform || 'android']
  );
  res.status(204).end();
}

// DELETE /api/push/register   { token }
// Called on logout so a shared/reinstalled device stops receiving another
// user's notifications.
async function unregisterToken(req, res) {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token is required' });
  await db.query('DELETE FROM device_push_tokens WHERE token = $1 AND user_id = $2', [token, req.user.sub]);
  res.status(204).end();
}

module.exports = { registerToken, unregisterToken };
