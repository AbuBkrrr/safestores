// ------------------------------------------------------------
// Store-level user & invite management for the standalone web edition —
// how a store admin/manager brings on cashiers/staff over the LAN
// (see authController.inviteLogin for the claim side of this).
// Postgres-flavored twin of desktop/server/controllers/usersController.js.
// ------------------------------------------------------------

const crypto = require('crypto');
const db = require('../config/db');
const { generateInviteCode } = require('../utils/codes');

// GET /api/stores/:storeId/users
async function listUsers(req, res) {
  const { storeId } = req.params;
  const { rows } = await db.query(
    `SELECT id, name, email, role, status, created_at FROM users WHERE store_id = $1 ORDER BY created_at DESC`,
    [storeId]
  );
  res.json(rows);
}

// DELETE /api/stores/:storeId/users/:userId
async function removeUser(req, res) {
  const { storeId, userId } = req.params;
  const { rowCount } = await db.query('DELETE FROM users WHERE id = $1 AND store_id = $2', [userId, storeId]);
  if (rowCount === 0) return res.status(404).json({ error: 'User not found' });
  res.status(204).end();
}

// PATCH /api/stores/:storeId/users/:userId  { status }
async function updateUserStatus(req, res) {
  const { storeId, userId } = req.params;
  const { status } = req.body;
  if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const { rows } = await db.query(
    `UPDATE users SET status = $1 WHERE id = $2 AND store_id = $3 RETURNING id, name, status`,
    [status, userId, storeId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
}

// GET /api/stores/:storeId/invites
async function listInvites(req, res) {
  const { storeId } = req.params;
  const { rows } = await db.query('SELECT * FROM invites WHERE store_id = $1 ORDER BY created_at DESC', [storeId]);
  res.json(rows);
}

// POST /api/stores/:storeId/invites   { name, email?, role }
async function createInvite(req, res) {
  const { storeId } = req.params;
  const { name, email, role } = req.body;
  if (!name || !role) return res.status(400).json({ error: 'name and role are required' });

  const code = generateInviteCode();
  const { rows } = await db.query(
    `INSERT INTO invites (store_id, code, name, email, role) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [storeId, code, name, email || null, role]
  );
  res.status(201).json(rows[0]);
}

// POST /api/stores/:storeId/invites/bulk   { names: "a, b, c", emailDomain?, role }
async function createBulkInvites(req, res) {
  const { storeId } = req.params;
  const { names, emailDomain, role } = req.body;
  if (!names || !role) return res.status(400).json({ error: 'names and role are required' });

  const nameList = names.split(',').map((n) => n.trim()).filter(Boolean);
  if (nameList.length === 0) return res.status(400).json({ error: 'No valid names provided' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query(
      'SELECT email FROM users WHERE store_id = $1 AND email IS NOT NULL',
      [storeId]
    );
    const usedEmails = new Set(existing.map((r) => r.email.toLowerCase()));
    const created = [];
    for (const name of nameList) {
      const code = generateInviteCode();
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
      let email = null;
      if (emailDomain) {
        email = `${slug}@${emailDomain}`;
        let n = 2;
        while (usedEmails.has(email)) {
          email = `${slug}${n}@${emailDomain}`;
          n += 1;
        }
        usedEmails.add(email);
      }
      const { rows } = await client.query(
        `INSERT INTO invites (store_id, code, name, email, role) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [storeId, code, name, email, role]
      );
      created.push(rows[0]);
    }
    await client.query('COMMIT');
    res.status(201).json(created);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Bulk invite creation failed' });
  } finally {
    client.release();
  }
}

// PATCH /api/stores/:storeId/invites/:inviteId/revoke
async function revokeInvite(req, res) {
  const { storeId, inviteId } = req.params;
  const { rows } = await db.query(
    `UPDATE invites SET status = 'revoked' WHERE id = $1 AND store_id = $2 AND status != 'claimed' RETURNING *`,
    [inviteId, storeId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Invite not found or already claimed' });
  res.json(rows[0]);
}

module.exports = {
  listUsers, removeUser, updateUserStatus,
  listInvites, createInvite, createBulkInvites, revokeInvite,
};
