// ------------------------------------------------------------
// Desktop twin of backend/src/controllers/accountController.js — the
// parts that make sense on a single offline machine: change password,
// sign out everywhere, personal data export, activity log, and an admin
// setting a staff member's password (the offline stand-in for an emailed
// "forgot password" link). Email verification and authenticator-app 2FA
// are cloud-only: a local install has no mail server and no remote login.
// ------------------------------------------------------------
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken } = require('../utils/jwt');
const { checkPassword } = require('../utils/passwordPolicy');
const { logActivity } = require('../utils/activityLog');

const table = (role) => (role === 'super_admin' ? 'super_admins' : 'users');

function me(req, res) {
  const acct = db.prepare(`SELECT * FROM ${table(req.user.role)} WHERE id = ?`).get(req.user.sub);
  if (!acct) return res.status(404).json({ error: 'Account not found' });
  res.json({ id: acct.id, name: acct.name, email: acct.email, role: req.user.role, hasPassword: !!acct.password_hash, emailVerified: true, twoFactorEnabled: false, twoFactorAvailable: false });
}

async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body || {};
  const problem = checkPassword(newPassword);
  if (problem) return res.status(400).json({ error: problem });
  const t = table(req.user.role);
  const acct = db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(req.user.sub);
  if (!acct) return res.status(404).json({ error: 'Account not found' });
  if (acct.password_hash && !(await bcrypt.compare(String(currentPassword || ''), acct.password_hash))) {
    return res.status(400).json({ error: 'Your current password is incorrect.' });
  }
  const hash = await bcrypt.hash(newPassword, 10);
  db.prepare(`UPDATE ${t} SET password_hash = ?, token_version = token_version + 1 WHERE id = ?`).run(hash, acct.id);
  const tv = db.prepare(`SELECT token_version FROM ${t} WHERE id = ?`).get(acct.id).token_version;
  logActivity(req, { action: 'account.password_changed', entityType: 'user', entityId: acct.id });
  res.json({ message: 'Password changed. Other devices have been signed out.', token: signToken({ sub: acct.id, role: req.user.role, storeId: req.user.storeId || null, tv }) });
}

function logoutAll(req, res) {
  const t = table(req.user.role);
  db.prepare(`UPDATE ${t} SET token_version = token_version + 1 WHERE id = ?`).run(req.user.sub);
  const row = db.prepare(`SELECT token_version FROM ${t} WHERE id = ?`).get(req.user.sub);
  if (!row) return res.status(404).json({ error: 'Account not found' });
  logActivity(req, { action: 'account.signed_out_everywhere', entityType: 'user', entityId: req.user.sub });
  res.json({ message: 'Signed out on all other devices.', token: signToken({ sub: req.user.sub, role: req.user.role, storeId: req.user.storeId || null, tv: row.token_version }) });
}

function exportMyData(req, res) {
  const acct = db.prepare(`SELECT * FROM ${table(req.user.role)} WHERE id = ?`).get(req.user.sub);
  if (!acct) return res.status(404).json({ error: 'Account not found' });
  const { password_hash, ...profile } = acct;
  const activity = db.prepare('SELECT action, entity_type, entity_id, details, created_at FROM activity_log WHERE actor_id = ? ORDER BY created_at DESC LIMIT 5000').all(acct.id)
    .map((a) => ({ ...a, details: safeJson(a.details) }));
  res.setHeader('Content-Disposition', `attachment; filename="my-safestores-data-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ exportedAt: new Date().toISOString(), accountType: req.user.role === 'super_admin' ? 'super_admin' : 'user', profile, activity });
}

function listActivity(req, res) {
  const storeId = req.params.storeId || req.query.storeId || null;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const where = []; const params = [];
  if (storeId) { where.push('a.store_id = ?'); params.push(storeId); }
  if (req.query.action) { where.push('a.action LIKE ?'); params.push(`${req.query.action}%`); }
  if (req.query.before) { where.push('a.created_at < ?'); params.push(req.query.before); }
  params.push(limit);
  const rows = db.prepare(
    `SELECT a.*, s.name AS store_name FROM activity_log a LEFT JOIN stores s ON s.id = a.store_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.created_at DESC LIMIT ?`
  ).all(...params).map((a) => ({ ...a, details: safeJson(a.details) }));
  res.json(rows);
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

module.exports = { me, changePassword, logoutAll, exportMyData, listActivity };
