// ------------------------------------------------------------
// Store-level user & invite management for the standalone web edition —
// how a store admin/manager brings on cashiers/staff over the LAN
// (see authController.inviteLogin for the claim side of this).
// Postgres-flavored twin of desktop/server/controllers/usersController.js.
// ------------------------------------------------------------

const crypto = require('crypto');
const db = require('../config/db');
const { logActivity } = require('../utils/activityLog');
const bcrypt = require('bcryptjs');
const { checkPassword } = require('../utils/passwordPolicy');
const { generateInviteCode } = require('../utils/codes');

// Every role a store user can be invited as.
const INVITE_ROLES = ['admin', 'manager', 'cashier', 'checkout', 'staff', 'store_manager', 'shelf_manager', 'stock_taker', 'marketplace_manager', 'security'];

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
  logActivity(req, { storeId, action: 'user.removed', entityType: 'user', entityId: userId });
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
  logActivity(req, { storeId, action: `user.${status === 'active' ? 'enabled' : 'disabled'}`, entityType: 'user', entityId: userId, details: { name: rows[0].name } });
}

// PATCH /api/stores/:storeId/users/:userId/password { password } — admin sets
// a staff member's password (works with no email server at all). Signs
// that person out everywhere.
async function setUserPassword(req, res) {
  const { storeId, userId } = req.params;
  const problem = checkPassword(req.body?.password);
  if (problem) return res.status(400).json({ error: problem });
  const hash = await bcrypt.hash(req.body.password, 10);
  const { rows } = await db.query(
    'UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2 AND store_id = $3 RETURNING id, name',
    [hash, userId, storeId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  logActivity(req, { storeId, action: 'user.password_set_by_admin', entityType: 'user', entityId: userId, details: { name: rows[0].name } });
  res.json({ message: `Password set for ${rows[0].name}. They have been signed out of other devices.` });
}

// Mini stores are small shops: the owner plus a couple of helpers. Only these
// helper roles fit; the chain-of-custody roles come with Midi and Mega.
const MINI_ROLES = ['manager', 'cashier', 'staff'];

/** Checks the store's size rules before adding `adding` people with `role`. Returns an error message or null. */
async function teamProblem(storeId, role, adding = 1) {
  const { rows } = await db.query(
    `SELECT s.store_tier, t.label, t.max_users FROM stores s LEFT JOIN store_tiers t ON t.tier = s.store_tier WHERE s.id = $1`, [storeId]
  );
  const s = rows[0];
  if (!s) return 'Store not found';
  if (s.store_tier === 'mini' && !MINI_ROLES.includes(role)) {
    return 'A Mini store is run by the owner alone or with up to 4 helpers (5 people in all) as manager, cashier or shop assistant. Upgrade to Midi for store managers, shelf managers, security and online market managers.';
  }
  if (s.max_users) {
    const { rows: c } = await db.query(
      `SELECT (SELECT COUNT(*) FROM users WHERE store_id = $1 AND status = 'active')::int
            + (SELECT COUNT(*) FROM invites WHERE store_id = $1 AND status = 'pending')::int AS n`, [storeId]
    );
    if (c[0].n + adding > s.max_users) {
      return `${s.label || 'This store'} allows ${s.max_users} people including you (${c[0].n} already, counting pending invites). Revoke an unused invite, disable someone who left, or upgrade your store size.`;
    }
  }
  return null;
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
  if (!INVITE_ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${INVITE_ROLES.join(', ')}` });
  const problem = await teamProblem(storeId, role);
  if (problem) return res.status(400).json({ error: problem, code: 'TEAM_LIMIT' });

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
  if (!INVITE_ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${INVITE_ROLES.join(', ')}` });
  const bulkCount = String(names).split(',').map((n) => n.trim()).filter(Boolean).length;
  const bulkProblem = await teamProblem(storeId, role, bulkCount);
  if (bulkProblem) return res.status(400).json({ error: bulkProblem, code: 'TEAM_LIMIT' });

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
  setUserPassword,
  listUsers, removeUser, updateUserStatus,
  listInvites, createInvite, createBulkInvites, revokeInvite,
};
