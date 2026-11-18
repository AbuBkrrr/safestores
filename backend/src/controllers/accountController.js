// ------------------------------------------------------------
// Account self-service: password reset, email verification, change
// password, two-factor (TOTP), sign-out-everywhere, personal data export,
// account/store deletion. Shared by store users and super admins.
// ------------------------------------------------------------
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { signToken } = require('../utils/jwt');
const { sendMail } = require('../utils/mailer');
const totp = require('../utils/totp');
const { checkPassword } = require('../utils/passwordPolicy');
const { logActivity } = require('../utils/activityLog');

const RESET_TTL_MIN = 60;
const VERIFY_TTL_HOURS = 72;
const STORE_DELETION_GRACE_DAYS = 30;

function frontendBase() {
  return (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim().replace(/\/$/, '');
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

async function issueToken(kind, accountId, purpose, ttlMs) {
  const raw = crypto.randomBytes(32).toString('base64url');
  // Only one live token per account+purpose: older links stop working.
  await db.query(
    `UPDATE auth_tokens SET used_at = now() WHERE account_kind = $1 AND account_id = $2 AND purpose = $3 AND used_at IS NULL`,
    [kind, accountId, purpose]
  );
  await db.query(
    `INSERT INTO auth_tokens (account_kind, account_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3,$4,$5)`,
    [kind, accountId, purpose, sha256(raw), new Date(Date.now() + ttlMs)]
  );
  return raw;
}

async function consumeToken(raw, purpose) {
  if (!raw) return null;
  const { rows } = await db.query(
    `UPDATE auth_tokens SET used_at = now()
     WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
     RETURNING account_kind, account_id`,
    [sha256(raw), purpose]
  );
  return rows[0] || null;
}

/** Table + columns for an account kind (store user vs super admin). */
function accountTable(kind) {
  return kind === 'super_admin' ? 'super_admins' : 'users';
}

function kindFor(role) {
  return role === 'super_admin' ? 'super_admin' : 'user';
}

async function loadAccount(kind, id) {
  const { rows } = await db.query(`SELECT * FROM ${accountTable(kind)} WHERE id = $1`, [id]);
  return rows[0] || null;
}

/** Re-mints a session token carrying the account's current token_version. */
function tokenFor(account, role, storeId) {
  return signToken({ sub: account.id, role, storeId: storeId || null, tv: account.token_version || 0 });
}

// ---------------- Email verification ----------------

async function sendVerificationEmail(user) {
  if (!user?.email || user.email.endsWith('@invite.local')) return false;
  const raw = await issueToken('user', user.id, 'email_verify', VERIFY_TTL_HOURS * 3600 * 1000);
  const link = `${frontendBase()}/verify-email?token=${raw}`;
  return sendMail({
    to: user.email,
    subject: 'Confirm your email for SAFE Stores',
    text: `Hi ${user.name || ''},\n\nPlease confirm your email address by opening this link:\n${link}\n\nThe link expires in ${VERIFY_TTL_HOURS} hours. If you didn't create a SAFE Stores account, you can ignore this email.`,
    html: `<p>Hi ${escapeHtml(user.name || '')},</p><p>Please confirm your email address for SAFE Stores:</p><p><a href="${link}">Confirm my email</a></p><p style="color:#666">This link expires in ${VERIFY_TTL_HOURS} hours. If you didn't create an account, ignore this email.</p>`,
  });
}

// POST /api/auth/email/verify { token }
async function verifyEmail(req, res) {
  const tok = await consumeToken(req.body?.token, 'email_verify');
  if (!tok) return res.status(400).json({ error: 'This verification link is invalid or has expired. Request a new one from your account page.' });
  await db.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1', [tok.account_id]);
  res.json({ message: 'Email confirmed. Thank you!' });
}

// POST /api/account/email/resend
async function resendVerification(req, res) {
  if (req.user.role === 'super_admin') return res.json({ message: 'Nothing to verify.' });
  const user = await loadAccount('user', req.user.sub);
  if (!user) return res.status(404).json({ error: 'Account not found' });
  if (user.email_verified_at) return res.json({ message: 'Your email is already confirmed.' });
  const sent = await sendVerificationEmail(user);
  res.json({ message: sent ? 'Verification email sent.' : 'Email sending is not configured on this server yet — ask the system administrator.' , sent });
}

// ---------------- Password reset ----------------

// POST /api/auth/password/forgot { email }
// Always answers the same way, whether or not the email exists, so it
// can't be used to discover who has an account.
async function forgotPassword(req, res) {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const generic = { message: 'If an account exists for that email, a reset link is on its way. Check your inbox (and spam folder).' };
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const { rows: users } = await db.query(
    `SELECT u.id, u.name, u.email, s.name AS store_name FROM users u JOIN stores s ON s.id = u.store_id
     WHERE lower(u.email) = $1 AND u.password_hash IS NOT NULL AND u.status = 'active'`,
    [email]
  );
  const { rows: supers } = await db.query('SELECT id, name, email FROM super_admins WHERE lower(email) = $1', [email]);

  const targets = [
    ...users.map((u) => ({ kind: 'user', ...u })),
    ...supers.map((s) => ({ kind: 'super_admin', ...s, store_name: 'SAFE Stores administration' })),
  ];
  for (const acct of targets) {
    const raw = await issueToken(acct.kind, acct.id, 'password_reset', RESET_TTL_MIN * 60 * 1000);
    const link = `${frontendBase()}/reset-password?token=${raw}`;
    await sendMail({
      to: acct.email,
      subject: 'Reset your SAFE Stores password',
      text: `Hi ${acct.name || ''},\n\nSomeone (hopefully you) asked to reset the password for your account at ${acct.store_name}.\n\nReset it here: ${link}\n\nThis link works once and expires in ${RESET_TTL_MIN} minutes. If you didn't ask for this, you can ignore this email — your password won't change.`,
      html: `<p>Hi ${escapeHtml(acct.name || '')},</p><p>Someone asked to reset the password for your account at <strong>${escapeHtml(acct.store_name)}</strong>.</p><p><a href="${link}">Choose a new password</a></p><p style="color:#666">This link works once and expires in ${RESET_TTL_MIN} minutes. If you didn't ask for this, ignore this email.</p>`,
    });
  }
  res.json(generic);
}

// POST /api/auth/password/reset { token, password }
async function resetPassword(req, res) {
  const { token, password } = req.body || {};
  const problem = checkPassword(password);
  if (problem) return res.status(400).json({ error: problem });
  const tok = await consumeToken(token, 'password_reset');
  if (!tok) return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });

  const hash = await bcrypt.hash(password, 10);
  const table = accountTable(tok.account_kind);
  await db.query(`UPDATE ${table} SET password_hash = $1, token_version = token_version + 1 WHERE id = $2`, [hash, tok.account_id]);
  // A reset link proves control of the inbox, so it also confirms the email.
  if (tok.account_kind === 'user') {
    await db.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1', [tok.account_id]);
    const { rows } = await db.query('SELECT store_id FROM users WHERE id = $1', [tok.account_id]);
    await logActivity({ user: { sub: tok.account_id }, ip: req.ip }, { storeId: rows[0]?.store_id || null, action: 'account.password_reset', entityType: 'user', entityId: tok.account_id });
  }
  res.json({ message: 'Password updated. You can now sign in with your new password.' });
}

// ---------------- Signed-in account management ----------------

// GET /api/account/me
async function me(req, res) {
  const kind = kindFor(req.user.role);
  const acct = await loadAccount(kind, req.user.sub);
  if (!acct) return res.status(404).json({ error: 'Account not found' });
  res.json({
    id: acct.id, name: acct.name, email: acct.email, role: req.user.role,
    hasPassword: !!acct.password_hash,
    emailVerified: kind === 'super_admin' ? true : !!acct.email_verified_at,
    twoFactorEnabled: !!acct.totp_enabled,
  });
}

// POST /api/account/password { currentPassword, newPassword }
async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body || {};
  const problem = checkPassword(newPassword);
  if (problem) return res.status(400).json({ error: problem });
  const kind = kindFor(req.user.role);
  const acct = await loadAccount(kind, req.user.sub);
  if (!acct) return res.status(404).json({ error: 'Account not found' });
  if (acct.password_hash) {
    const ok = await bcrypt.compare(String(currentPassword || ''), acct.password_hash);
    if (!ok) return res.status(400).json({ error: 'Your current password is incorrect.' });
  }
  const hash = await bcrypt.hash(newPassword, 10);
  const { rows } = await db.query(
    `UPDATE ${accountTable(kind)} SET password_hash = $1, token_version = token_version + 1 WHERE id = $2 RETURNING *`,
    [hash, acct.id]
  );
  await logActivity(req, { action: 'account.password_changed', entityType: 'user', entityId: acct.id });
  // Every other device is signed out; this one gets a fresh token.
  res.json({ message: 'Password changed. Other devices have been signed out.', token: tokenFor(rows[0], req.user.role, req.user.storeId) });
}

// POST /api/account/logout-all
async function logoutAll(req, res) {
  const kind = kindFor(req.user.role);
  const { rows } = await db.query(
    `UPDATE ${accountTable(kind)} SET token_version = token_version + 1 WHERE id = $1 RETURNING *`,
    [req.user.sub]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Account not found' });
  await logActivity(req, { action: 'account.signed_out_everywhere', entityType: 'user', entityId: req.user.sub });
  res.json({ message: 'Signed out on all other devices.', token: tokenFor(rows[0], req.user.role, req.user.storeId) });
}

// POST /api/account/2fa/setup — generates a NEW pending secret (not yet enabled)
async function setupTwoFactor(req, res) {
  const kind = kindFor(req.user.role);
  const acct = await loadAccount(kind, req.user.sub);
  if (!acct) return res.status(404).json({ error: 'Account not found' });
  if (!acct.password_hash) return res.status(400).json({ error: 'Two-factor login needs a password-based account.' });
  if (acct.totp_enabled) return res.status(400).json({ error: 'Two-factor login is already on. Turn it off first to set up a new device.' });
  const secret = totp.generateSecret();
  await db.query(`UPDATE ${accountTable(kind)} SET totp_secret = $1 WHERE id = $2`, [secret, acct.id]);
  res.json({ secret, otpauthUrl: totp.otpauthUrl({ secret, label: acct.email }) });
}

// POST /api/account/2fa/enable { code }
async function enableTwoFactor(req, res) {
  const kind = kindFor(req.user.role);
  const acct = await loadAccount(kind, req.user.sub);
  if (!acct?.totp_secret) return res.status(400).json({ error: 'Start two-factor setup first.' });
  if (!totp.verifyCode(acct.totp_secret, req.body?.code)) return res.status(400).json({ error: 'That code is not correct. Check your authenticator app and try again.' });
  await db.query(`UPDATE ${accountTable(kind)} SET totp_enabled = true WHERE id = $1`, [acct.id]);
  await logActivity(req, { action: 'account.2fa_enabled', entityType: 'user', entityId: acct.id });
  res.json({ message: 'Two-factor login is now on.' });
}

// POST /api/account/2fa/disable { password, code }
async function disableTwoFactor(req, res) {
  const kind = kindFor(req.user.role);
  const acct = await loadAccount(kind, req.user.sub);
  if (!acct) return res.status(404).json({ error: 'Account not found' });
  if (!acct.totp_enabled) return res.json({ message: 'Two-factor login is already off.' });
  const okPw = acct.password_hash && await bcrypt.compare(String(req.body?.password || ''), acct.password_hash);
  if (!okPw || !totp.verifyCode(acct.totp_secret, req.body?.code)) {
    return res.status(400).json({ error: 'Password or code is incorrect.' });
  }
  await db.query(`UPDATE ${accountTable(kind)} SET totp_enabled = false, totp_secret = NULL WHERE id = $1`, [acct.id]);
  await logActivity(req, { action: 'account.2fa_disabled', entityType: 'user', entityId: acct.id });
  res.json({ message: 'Two-factor login is now off.' });
}

// GET /api/account/export — everything we hold about *this person*
async function exportMyData(req, res) {
  const kind = kindFor(req.user.role);
  const acct = await loadAccount(kind, req.user.sub);
  if (!acct) return res.status(404).json({ error: 'Account not found' });
  const { password_hash, totp_secret, ...profile } = acct; // never export secrets
  const { rows: activity } = await db.query(
    'SELECT action, entity_type, entity_id, details, created_at FROM activity_log WHERE actor_id = $1 ORDER BY created_at DESC LIMIT 5000',
    [acct.id]
  );
  res.setHeader('Content-Disposition', `attachment; filename="my-safestores-data-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ exportedAt: new Date().toISOString(), accountType: kind, profile, activity });
}

// DELETE /api/account { password } — a staff member erasing their own
// account. Their name/email are anonymised (sales they rang up stay in the
// store's books, attributed to "Deleted user"). A store's last admin must
// close the store instead (see requestStoreDeletion).
async function deleteMyAccount(req, res) {
  if (req.user.role === 'super_admin') return res.status(400).json({ error: 'Super admin accounts are removed by another super admin.' });
  const user = await loadAccount('user', req.user.sub);
  if (!user) return res.status(404).json({ error: 'Account not found' });
  if (user.password_hash) {
    const ok = await bcrypt.compare(String(req.body?.password || ''), user.password_hash);
    if (!ok) return res.status(400).json({ error: 'Password is incorrect.' });
  }
  if (user.role === 'admin') {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM users WHERE store_id = $1 AND role = 'admin' AND status = 'active' AND id <> $2`,
      [user.store_id, user.id]
    );
    if (rows[0].n === 0) return res.status(400).json({ error: 'You are the only admin. Make someone else an admin first, or close the store from Settings.' });
  }
  await db.query(
    `UPDATE users SET name = 'Deleted user', email = $1, password_hash = NULL, totp_secret = NULL, totp_enabled = false,
       status = 'disabled', token_version = token_version + 1 WHERE id = $2`,
    [`deleted-${user.id}@deleted.local`, user.id]
  );
  await logActivity(req, { action: 'account.deleted', entityType: 'user', entityId: user.id });
  res.json({ message: 'Your account has been deleted.' });
}

// POST /api/stores/:storeId/deletion { password, confirmName }
async function requestStoreDeletion(req, res) {
  const { storeId } = req.params;
  const user = await loadAccount('user', req.user.sub);
  const ok = user?.password_hash && await bcrypt.compare(String(req.body?.password || ''), user.password_hash);
  if (!ok) return res.status(400).json({ error: 'Password is incorrect.' });
  const { rows: s } = await db.query('SELECT name FROM stores WHERE id = $1', [storeId]);
  if (!s[0]) return res.status(404).json({ error: 'Store not found' });
  if (String(req.body?.confirmName || '').trim() !== s[0].name) {
    return res.status(400).json({ error: 'Type the store name exactly to confirm.' });
  }
  const when = new Date(Date.now() + STORE_DELETION_GRACE_DAYS * 86400000);
  await db.query('UPDATE stores SET deletion_requested_at = now(), deletion_scheduled_for = $1 WHERE id = $2', [when, storeId]);
  await logActivity(req, { action: 'store.deletion_requested', entityType: 'store', entityId: storeId, details: { scheduledFor: when } });
  res.json({ message: `Store scheduled for permanent deletion on ${when.toDateString()}. You can cancel any time before then.`, deletionScheduledFor: when });
}

// DELETE /api/stores/:storeId/deletion
async function cancelStoreDeletion(req, res) {
  await db.query('UPDATE stores SET deletion_requested_at = NULL, deletion_scheduled_for = NULL WHERE id = $1', [req.params.storeId]);
  await logActivity(req, { action: 'store.deletion_cancelled', entityType: 'store', entityId: req.params.storeId });
  res.json({ message: 'Store deletion cancelled.' });
}

// GET /api/stores/:storeId/deletion
async function getStoreDeletion(req, res) {
  const { rows } = await db.query('SELECT deletion_requested_at, deletion_scheduled_for FROM stores WHERE id = $1', [req.params.storeId]);
  res.json(rows[0] || {});
}

/** Hard-deletes stores whose grace period has passed. Called by retentionJob. */
async function purgeDueStoreDeletions() {
  const { rows } = await db.query('DELETE FROM stores WHERE deletion_scheduled_for IS NOT NULL AND deletion_scheduled_for <= now() RETURNING id, name');
  for (const r of rows) console.log(`Retention: permanently deleted store ${r.name} (${r.id}) after its grace period.`);
  // Expired one-time tokens are useless; keep the table small.
  await db.query(`DELETE FROM auth_tokens WHERE expires_at < now() - interval '7 days'`);
  return rows.length;
}

// GET /api/stores/:storeId/activity?limit=&before=&action=   and  GET /api/super/activity
async function listActivity(req, res) {
  const storeId = req.params.storeId || req.query.storeId || null;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const params = [];
  const where = [];
  if (storeId) { params.push(storeId); where.push(`store_id = $${params.length}`); }
  if (req.query.action) { params.push(`${req.query.action}%`); where.push(`action LIKE $${params.length}`); }
  if (req.query.before) { params.push(req.query.before); where.push(`created_at < $${params.length}`); }
  params.push(limit);
  const { rows } = await db.query(
    `SELECT a.*, s.name AS store_name FROM activity_log a LEFT JOIN stores s ON s.id = a.store_id
     ${where.length ? `WHERE ${where.map((w) => `a.${w}`).join(' AND ')}` : ''}
     ORDER BY a.created_at DESC LIMIT $${params.length}`,
    params
  );
  res.json(rows);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = {
  sendVerificationEmail, verifyEmail, resendVerification, forgotPassword, resetPassword,
  me, changePassword, logoutAll, setupTwoFactor, enableTwoFactor, disableTwoFactor,
  exportMyData, deleteMyAccount, requestStoreDeletion, cancelStoreDeletion, getStoreDeletion,
  purgeDueStoreDeletions, listActivity, tokenFor,
};
