const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { signToken } = require('../utils/jwt');
const { generateInviteCode } = require('../utils/codes');

// ------------------------------------------------------------
// POST /api/auth/super-admin/login
// ------------------------------------------------------------
async function superAdminLogin(req, res) {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const { rows } = await db.query('SELECT * FROM super_admins WHERE email = $1', [email]);
  const admin = rows[0];
  if (!admin) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, admin.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const token = signToken({ sub: admin.id, role: 'super_admin', storeId: null });
  res.json({ token, user: { id: admin.id, name: admin.name, email: admin.email, role: 'super_admin' } });
}

// ------------------------------------------------------------
// POST /api/auth/store/signup
// body: { storeName, adminName, adminEmail, password, referralContact? }
// Store tier (mini/midi/mega) and billing model are assigned by the Super
// Admin at activation time, not chosen here — see storesController.activateStore.
// referralContact is an optional marketer/affiliate email or phone number
// the signer-up was referred by — see 023_referral_tracking.sql for why.
// ------------------------------------------------------------
async function storeSignup(req, res) {
  const { storeName, adminName, adminEmail, password, referralContact, storeTier } = req.body;
  if (!storeName || !adminName || !adminEmail || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const storeResult = await client.query(
      `INSERT INTO stores (name, subscription_status, referral_contact, requested_tier)
       VALUES ($1, 'pending', $2, $3) RETURNING id, name, subscription_status, store_tier, requested_tier, referral_contact`,
      [storeName, referralContact || null, ['mini', 'midi', 'mega'].includes(storeTier) ? storeTier : null]
    );
    const store = storeResult.rows[0];

    const passwordHash = await bcrypt.hash(password, 10);
    const userResult = await client.query(
      `INSERT INTO users (store_id, name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, 'admin') RETURNING id, name, email, role`,
      [store.id, adminName, adminEmail, passwordHash]
    );

    await client.query('COMMIT');
    res.status(201).json({
      message: 'Store registered! You can log in right away to activate your subscription with an access code.',
      store,
      admin: userResult.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Email already in use for this store' });
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------
// POST /api/auth/admin/login  (store admin / manager / staff with password)
// body: { email, password }
// ------------------------------------------------------------
async function adminLogin(req, res) {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const { rows } = await db.query(
    `SELECT u.*, s.subscription_status, s.name AS store_name, s.sync_key, s.locked
     FROM users u JOIN stores s ON s.id = u.store_id
     WHERE u.email = $1 AND u.password_hash IS NOT NULL`,
    [email]
  );
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  if (user.subscription_status === 'suspended') {
    return res.status(403).json({ error: 'This store\'s subscription is suspended. Contact support.' });
  }
  if (user.status === 'disabled') {
    return res.status(403).json({ error: 'This account has been disabled.' });
  }

  // Pending stores ARE allowed to log in (role: admin only) so they can redeem
  // an access code from inside the app — but non-admin invited users cannot,
  // since there's nothing useful for them to do until the store is active.
  if (user.subscription_status === 'pending' && user.role !== 'admin') {
    return res.status(403).json({ error: 'This store is not yet activated. Ask your admin to activate it first.' });
  }

  const token = signToken({ sub: user.id, role: user.role, storeId: user.store_id });
  res.json({
    token,
    user: {
      id: user.id, name: user.name, email: user.email, role: user.role,
      storeId: user.store_id, storeName: user.store_name, subscriptionStatus: user.subscription_status,
      syncKey: user.sync_key, locked: !!user.locked,
    },
  });
}

// ------------------------------------------------------------
// POST /api/auth/invite/login
// body: { code }
// Claims a one-time invite code and issues a session for that user.
// If the invite hasn't been claimed yet, it creates the user record now.
// ------------------------------------------------------------
async function inviteLogin(req, res) {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Invite code required' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT i.*, s.subscription_status, s.sync_key FROM invites i
       JOIN stores s ON s.id = i.store_id
       WHERE i.code = $1 FOR UPDATE`,
      [code]
    );
    const invite = rows[0];
    if (!invite) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Invite code not found' });
    }
    if (invite.status === 'revoked') {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'This invite code has been revoked' });
    }
    if (invite.subscription_status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This store is not currently active' });
    }

    let userId = invite.claimed_by_user;

    if (invite.status === 'pending') {
      // First use: create the user now and mark invite claimed.
      const userResult = await client.query(
        `INSERT INTO users (store_id, name, email, password_hash, role, audit_engagement_id)
         VALUES ($1, $2, $3, NULL, $4, $5) RETURNING id`,
        [invite.store_id, invite.name, invite.email || `${invite.code.toLowerCase()}@invite.local`, invite.role, invite.audit_engagement_id || null]
      );
      userId = userResult.rows[0].id;
      await client.query(
        `UPDATE invites SET status = 'claimed', claimed_by_user = $1 WHERE id = $2`,
        [userId, invite.id]
      );
    } else {
      // Repeat use: the invite code doubles as this person's ongoing login
      // credential (see users.password_hash's own comment — invite-only
      // accounts never get one), so a store admin disabling them in
      // Users.jsx must actually block this path too, not just their
      // existing session (see requireAuth's matching check for that half).
      const { rows: userRows } = await client.query('SELECT status FROM users WHERE id = $1', [userId]);
      if (!userRows[0] || userRows[0].status !== 'active') {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'This account is no longer active. Contact your store admin.', code: 'ACCOUNT_DISABLED' });
      }
    }

    await client.query('COMMIT');

    const token = signToken({ sub: userId, role: invite.role, storeId: invite.store_id });
    res.json({ token, user: { id: userId, name: invite.name, role: invite.role, storeId: invite.store_id, syncKey: invite.sync_key } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Invite login failed' });
  } finally {
    client.release();
  }
}

module.exports = { superAdminLogin, storeSignup, adminLogin, inviteLogin };
