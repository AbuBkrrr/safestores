const crypto = require('crypto');
const db = require('../db');
const { generateInviteCode } = require('../utils/codes');

// GET /api/stores/:storeId/users
function listUsers(req, res) {
  const { storeId } = req.params;
  res.json(db.prepare(
    `SELECT id, name, email, role, status, created_at FROM users WHERE store_id = ? ORDER BY created_at DESC`
  ).all(storeId));
}

// DELETE /api/stores/:storeId/users/:userId
function removeUser(req, res) {
  const { storeId, userId } = req.params;
  const result = db.prepare('DELETE FROM users WHERE id = ? AND store_id = ?').run(userId, storeId);
  if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
  res.status(204).end();
}

// PATCH /api/stores/:storeId/users/:userId  { status }
function updateUserStatus(req, res) {
  const { storeId, userId } = req.params;
  const { status } = req.body;
  if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE users SET status = ? WHERE id = ? AND store_id = ?').run(status, userId, storeId);
  const user = db.prepare('SELECT id, name, status FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
}

// GET /api/stores/:storeId/invites
function listInvites(req, res) {
  const { storeId } = req.params;
  res.json(db.prepare('SELECT * FROM invites WHERE store_id = ? ORDER BY created_at DESC').all(storeId));
}

// POST /api/stores/:storeId/invites   { name, email?, role }
function createInvite(req, res) {
  const { storeId } = req.params;
  const { name, email, role } = req.body;
  if (!name || !role) return res.status(400).json({ error: 'name and role are required' });

  const id = crypto.randomUUID();
  const code = generateInviteCode();
  db.prepare(
    `INSERT INTO invites (id, store_id, code, name, email, role) VALUES (?,?,?,?,?,?)`
  ).run(id, storeId, code, name, email || null, role);

  res.status(201).json(db.prepare('SELECT * FROM invites WHERE id = ?').get(id));
}

// POST /api/stores/:storeId/invites/bulk
function createBulkInvites(req, res) {
  const { storeId } = req.params;
  const { names, emailDomain, role } = req.body;
  if (!names || !role) return res.status(400).json({ error: 'names and role are required' });

  const nameList = names.split(',').map((n) => n.trim()).filter(Boolean);
  if (nameList.length === 0) return res.status(400).json({ error: 'No valid names provided' });

  try {
    const created = db.transaction(() => {
      const rows = [];
      const existing = db.prepare('SELECT email FROM users WHERE store_id = ? AND email IS NOT NULL').all(storeId);
      const usedEmails = new Set(existing.map((r) => r.email.toLowerCase()));
      for (const name of nameList) {
        const id = crypto.randomUUID();
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
        db.prepare(
          `INSERT INTO invites (id, store_id, code, name, email, role) VALUES (?,?,?,?,?,?)`
        ).run(id, storeId, code, name, email, role);
        rows.push(db.prepare('SELECT * FROM invites WHERE id = ?').get(id));
      }
      return rows;
    })();
    res.status(201).json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Bulk invite creation failed' });
  }
}

// PATCH /api/stores/:storeId/invites/:inviteId/revoke
function revokeInvite(req, res) {
  const { storeId, inviteId } = req.params;
  db.prepare(
    `UPDATE invites SET status = 'revoked' WHERE id = ? AND store_id = ? AND status != 'claimed'`
  ).run(inviteId, storeId);
  const invite = db.prepare('SELECT * FROM invites WHERE id = ?').get(inviteId);
  if (!invite || invite.status !== 'revoked') return res.status(404).json({ error: 'Invite not found or already claimed' });
  res.json(invite);
}

module.exports = {
  listUsers, removeUser, updateUserStatus,
  listInvites, createInvite, createBulkInvites, revokeInvite,
};
