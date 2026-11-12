const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { signToken } = require('../utils/jwt');

// ------------------------------------------------------------
// POST /api/auth/super-admin/login
// ------------------------------------------------------------
async function superAdminLogin(req, res) {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const admin = db.prepare('SELECT * FROM super_admins WHERE email = ?').get(email);
  if (!admin) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, admin.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const token = signToken({ sub: admin.id, role: 'super_admin', storeId: null, tv: admin.token_version || 0 });
  res.json({ token, user: { id: admin.id, name: admin.name, email: admin.email, role: 'super_admin' } });
}

// ------------------------------------------------------------
// POST /api/auth/store/signup
// ------------------------------------------------------------
async function storeSignup(req, res) {
  const { storeName, adminName, adminEmail, password, storeTier } = req.body;
  if (!storeName || !adminName || !adminEmail || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  if (storeTier && !['mini', 'midi', 'mega'].includes(storeTier)) {
    return res.status(400).json({ error: 'storeTier must be mini, midi, or mega' });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const result = db.transaction(() => {
      const storeId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO stores (id, name, store_tier, subscription_status, sync_key) VALUES (?, ?, ?, 'pending', ?)`
      ).run(storeId, storeName, storeTier || 'mini', crypto.randomUUID());
      const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);

      const userId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO users (id, store_id, name, email, password_hash, role) VALUES (?,?,?,?,?, 'admin')`
      ).run(userId, storeId, adminName, adminEmail, passwordHash);
      const admin = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(userId);

      return { store, admin };
    })();

    res.status(201).json({
      message: 'Store registered! A Super Admin will review your store and can adjust your tier if needed before you activate with an access code.',
      ...result,
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'Email already in use for this store' });
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
}

// ------------------------------------------------------------
// POST /api/auth/admin/login  (store admin / manager / staff with password)
// body: { email, password }
// ------------------------------------------------------------
async function adminLogin(req, res) {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = db.prepare(
    `SELECT u.*, s.subscription_status, s.name AS store_name, s.locked
     FROM users u JOIN stores s ON s.id = u.store_id
     WHERE u.email = ? AND u.password_hash IS NOT NULL`
  ).get(email);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  if (user.subscription_status === 'suspended') {
    return res.status(403).json({ error: "This store's subscription is suspended. Contact support." });
  }
  if (user.status === 'disabled') {
    return res.status(403).json({ error: 'This account has been disabled.' });
  }

  // Pending stores ARE allowed to log in (role: admin only) so they can redeem
  // an access code from inside the app — but non-admin invited users cannot,
  // since there's nothing useful for them to do until the store is active,
  // and invite logins are blocked separately for pending stores anyway.
  if (user.subscription_status === 'pending' && user.role !== 'admin') {
    return res.status(403).json({ error: 'This store is not yet activated. Ask your admin to activate it first.' });
  }

  const token = signToken({ sub: user.id, role: user.role, storeId: user.store_id, tv: user.token_version || 0 });
  res.json({
    token,
    user: {
      id: user.id, name: user.name, email: user.email, role: user.role,
      storeId: user.store_id, storeName: user.store_name, subscriptionStatus: user.subscription_status,
      locked: !!user.locked,
    },
  });
}

// ------------------------------------------------------------
// POST /api/auth/invite/login
// ------------------------------------------------------------
async function inviteLogin(req, res) {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Invite code required' });

  try {
    const result = db.transaction(() => {
      const invite = db.prepare(
        `SELECT i.*, s.subscription_status FROM invites i
         JOIN stores s ON s.id = i.store_id WHERE i.code = ?`
      ).get(code);
      if (!invite) return { error: [404, 'Invite code not found'] };
      if (invite.status === 'revoked') return { error: [410, 'This invite code has been revoked'] };
      if (invite.subscription_status !== 'active') return { error: [403, 'This store is not currently active'] };

      let userId = invite.claimed_by_user;
      if (invite.status === 'pending') {
        userId = crypto.randomUUID();
        db.prepare(
          `INSERT INTO users (id, store_id, name, email, password_hash, role) VALUES (?,?,?,?,NULL,?)`
        ).run(userId, invite.store_id, invite.name, invite.email || `${invite.code.toLowerCase()}@invite.local`, invite.role);
        db.prepare(`UPDATE invites SET status = 'claimed', claimed_by_user = ? WHERE id = ?`).run(userId, invite.id);
      } else {
        // Repeat use: the invite code doubles as this person's ongoing
        // login credential (invite-only accounts never get a
        // password_hash), so a store admin disabling them in Users.jsx
        // must actually block this path too, not just their existing
        // session (see requireAuth's matching check for that half).
        const user = db.prepare('SELECT status, token_version FROM users WHERE id = ?').get(userId);
        if (!user || user.status !== 'active') {
          return { error: [403, 'This account is no longer active. Contact your store admin.'] };
        }
      }

      const tv = db.prepare('SELECT token_version FROM users WHERE id = ?').get(userId)?.token_version || 0;
      return { userId, role: invite.role, storeId: invite.store_id, name: invite.name, tv };
    })();

    if (result.error) return res.status(result.error[0]).json({ error: result.error[1] });

    const token = signToken({ sub: result.userId, role: result.role, storeId: result.storeId, tv: result.tv });
    res.json({ token, user: { id: result.userId, name: result.name, role: result.role, storeId: result.storeId } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Invite login failed' });
  }
}

module.exports = { superAdminLogin, storeSignup, adminLogin, inviteLogin };
