const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const db = require('../db');
const { generateAccessCode } = require('../utils/codes');
const { loadConfig, saveConfig } = require('../syncAgent');

const VALID_TIERS = ['mini', 'midi', 'mega'];
const VALID_BILLING_MODELS = ['daily_percentage', 'custom'];

// GET /api/super/stores
function listStores(req, res) {
  const rows = db.prepare(
    `SELECT s.*, t.label AS tier_label,
            (SELECT COUNT(*) FROM users u WHERE u.store_id = s.id) AS user_count,
            (SELECT COUNT(*) FROM products pr WHERE pr.store_id = s.id) AS product_count
     FROM stores s LEFT JOIN store_tiers t ON t.tier = s.store_tier
     ORDER BY s.created_at DESC`
  ).all();
  res.json(rows);
}

// POST /api/super/stores
// body: { storeName, adminName, adminEmail, password, storeTier?, billingModel?, dailyRatePercent?, customBillingNotes? }
// Lets the Super Admin create a store (and its first admin user) directly,
// bypassing the public self-signup flow — the store is created already
// active, with whatever tier/billing the Super Admin chooses up front.
// POST /api/super/stores
// body: { storeName, adminName, adminEmail, password, storeTier?, billingModel?,
//         dailyRatePercent?, gracePeriodMinutes?, customBillingNotes?,
//         linkedStoreId?, linkedSyncKey?, cloudUrl? }
//
// linkedStoreId/linkedSyncKey/cloudUrl are how this device gets paired to
// a store that a Super Admin already registered centrally in the cloud —
// without this, a fresh desktop install always generates its own random
// store id + sync_key, completely disconnected from any cloud record, and
// backup sync silently never works (the cloud has no row matching this
// device's id at all). When provided, this verifies the pairing against
// the cloud BEFORE creating anything locally, then uses the cloud's own
// id/sync_key for the local row instead of generating new ones, and turns
// on cloud sync in this device's config — so the very next sync tick
// starts backing up to the right place.
async function createStore(req, res) {
  const {
    storeName, adminName, adminEmail, password,
    storeTier, billingModel, dailyRatePercent, gracePeriodMinutes, customBillingNotes,
    linkedStoreId, linkedSyncKey, cloudUrl, referralContact,
  } = req.body;

  if (!storeName || !adminName || !adminEmail || !password) {
    return res.status(400).json({ error: 'storeName, adminName, adminEmail, and password are required' });
  }
  if (storeTier && !VALID_TIERS.includes(storeTier)) {
    return res.status(400).json({ error: 'storeTier must be mini, midi, or mega' });
  }
  if (billingModel && !VALID_BILLING_MODELS.includes(billingModel)) {
    return res.status(400).json({ error: 'billingModel must be daily_percentage or custom' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const linking = !!(linkedStoreId && linkedSyncKey && cloudUrl);
  if ((linkedStoreId || linkedSyncKey || cloudUrl) && !linking) {
    return res.status(400).json({ error: 'Linking to a cloud store needs the Store ID, Sync Key, and Cloud URL all three' });
  }

  if (linking) {
    try {
      await axios.get(`${cloudUrl.replace(/\/$/, '')}/api/stores/${linkedStoreId}/marketplace-profile`, {
        headers: { 'X-Store-Sync-Key': linkedSyncKey }, timeout: 10000,
      });
    } catch (err) {
      if (err.response) return res.status(400).json({ error: 'That Store ID / Sync Key pair was rejected by the cloud — double-check both.' });
      return res.status(502).json({ error: 'Could not reach the cloud to verify — check the Cloud URL and your connection.' });
    }
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = db.transaction(() => {
      const storeId = linking ? linkedStoreId : crypto.randomUUID();
      const syncKey = linking ? linkedSyncKey : crypto.randomUUID();
      db.prepare(
        `INSERT INTO stores
           (id, name, store_tier, subscription_status, billing_model, daily_rate_percent, grace_period_minutes, custom_billing_notes, sync_key, referral_contact)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`
      ).run(
        storeId, storeName, storeTier || 'mini',
        billingModel || 'daily_percentage', dailyRatePercent ?? 1.0, gracePeriodMinutes ?? 5,
        customBillingNotes || null, syncKey, referralContact || null
      );
      const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);

      const userId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO users (id, store_id, name, email, password_hash, role) VALUES (?,?,?,?,?, 'admin')`
      ).run(userId, storeId, adminName, adminEmail, passwordHash);
      const admin = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(userId);

      return { store, admin };
    })();

    if (linking) saveConfig({ cloudUrl: cloudUrl.replace(/\/$/, ''), cloudEnabled: true });

    res.status(201).json({ ...result, linkedToCloud: linking });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'Email already in use for this store' });
    console.error(err);
    res.status(500).json({ error: 'Failed to create store' });
  }
}

// PATCH /api/super/stores/:id
// body: any of { name, storeTier, subscriptionStatus, billingModel, dailyRatePercent, gracePeriodMinutes, customBillingNotes, locked }
// General-purpose edit — tier corrections, subscription status, billing
// terms, and lock overrides all go through here from Manage Stores.
function updateStore(req, res) {
  const { id } = req.params;
  const {
    name, storeTier, subscriptionStatus, billingModel,
    dailyRatePercent, gracePeriodMinutes, customBillingNotes, locked,
  } = req.body;

  if (storeTier && !VALID_TIERS.includes(storeTier)) {
    return res.status(400).json({ error: 'storeTier must be mini, midi, or mega' });
  }
  if (billingModel && !VALID_BILLING_MODELS.includes(billingModel)) {
    return res.status(400).json({ error: 'billingModel must be daily_percentage or custom' });
  }
  if (subscriptionStatus && !['pending', 'active', 'suspended'].includes(subscriptionStatus)) {
    return res.status(400).json({ error: 'subscriptionStatus must be pending, active, or suspended' });
  }

  const existing = db.prepare('SELECT * FROM stores WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Store not found' });

  db.prepare(
    `UPDATE stores SET
       name = ?, store_tier = ?, subscription_status = ?, billing_model = ?,
       daily_rate_percent = ?, grace_period_minutes = ?, custom_billing_notes = ?, locked = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  ).run(
    name ?? existing.name,
    storeTier || existing.store_tier,
    subscriptionStatus || existing.subscription_status,
    billingModel || existing.billing_model,
    dailyRatePercent ?? existing.daily_rate_percent,
    gracePeriodMinutes ?? existing.grace_period_minutes,
    customBillingNotes !== undefined ? customBillingNotes : existing.custom_billing_notes,
    locked !== undefined ? (locked ? 1 : 0) : existing.locked,
    id
  );

  res.json(db.prepare('SELECT * FROM stores WHERE id = ?').get(id));
}

// PATCH /api/super/stores/:id/activate
// body: { storeTier?, billingModel?, dailyRatePercent?, customBillingNotes? }
// This is where the Super Admin assigns/corrects the store's size category
// (mini/midi/mega) and billing model when approving a pending signup.
function activateStore(req, res) {
  const { id } = req.params;
  const { storeTier, billingModel, dailyRatePercent, gracePeriodMinutes, customBillingNotes } = req.body;

  if (storeTier && !VALID_TIERS.includes(storeTier)) {
    return res.status(400).json({ error: 'storeTier must be mini, midi, or mega' });
  }
  if (billingModel && !VALID_BILLING_MODELS.includes(billingModel)) {
    return res.status(400).json({ error: 'billingModel must be daily_percentage or custom' });
  }

  const existing = db.prepare('SELECT * FROM stores WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Store not found' });

  db.prepare(
    `UPDATE stores SET
       subscription_status = 'active',
       store_tier = ?, billing_model = ?, daily_rate_percent = ?, grace_period_minutes = ?, custom_billing_notes = ?,
       locked = 0,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  ).run(
    storeTier || existing.store_tier,
    billingModel || existing.billing_model,
    dailyRatePercent ?? existing.daily_rate_percent,
    gracePeriodMinutes ?? existing.grace_period_minutes,
    customBillingNotes !== undefined ? customBillingNotes : existing.custom_billing_notes,
    id
  );

  res.json(db.prepare('SELECT * FROM stores WHERE id = ?').get(id));
}

// PATCH /api/super/stores/:id/suspend
function suspendStore(req, res) {
  const { id } = req.params;
  db.prepare(`UPDATE stores SET subscription_status = 'suspended', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(id);
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(id);
  if (!store) return res.status(404).json({ error: 'Store not found' });
  res.json(store);
}

// DELETE /api/super/stores/:id
function deleteStore(req, res) {
  const { id } = req.params;
  const result = db.prepare('DELETE FROM stores WHERE id = ?').run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'Store not found' });
  res.status(204).end();
}

// GET /api/super/tiers — store size categories (mini/midi/mega) and their limits
function listPlans(req, res) {
  res.json(db.prepare('SELECT * FROM store_tiers ORDER BY tier ASC').all());
}

// POST /api/super/access-codes  { intendedTier? }
function generateCode(req, res) {
  const { intendedTier } = req.body;
  if (intendedTier && !VALID_TIERS.includes(intendedTier)) {
    return res.status(400).json({ error: 'intendedTier must be mini, midi, or mega' });
  }

  const code = generateAccessCode();
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(
    `INSERT INTO access_codes (id, code, intended_tier, issued_by, expires_at) VALUES (?,?,?,?,?)`
  ).run(id, code, intendedTier || null, req.user.sub, expiresAt);

  res.status(201).json(db.prepare('SELECT * FROM access_codes WHERE id = ?').get(id));
}

// GET /api/super/access-codes
function listCodes(req, res) {
  const rows = db.prepare(
    `SELECT ac.*, s.name AS store_name
     FROM access_codes ac
     LEFT JOIN stores s ON s.id = ac.used_by_store
     ORDER BY ac.created_at DESC`
  ).all();
  res.json(rows);
}

// PATCH /api/super/access-codes/:id/revoke
function revokeCode(req, res) {
  const { id } = req.params;
  db.prepare(`UPDATE access_codes SET status = 'revoked' WHERE id = ? AND status = 'active'`).run(id);
  const code = db.prepare('SELECT * FROM access_codes WHERE id = ?').get(id);
  if (!code || code.status !== 'revoked') return res.status(404).json({ error: 'Active code not found' });
  res.json(code);
}

// POST /api/stores/:storeId/redeem-code   { code }
function redeemCode(req, res) {
  const { storeId } = req.params;
  const { code } = req.body;

  try {
    const result = db.transaction(() => {
      const ac = db.prepare('SELECT * FROM access_codes WHERE code = ?').get(code);
      if (!ac) return { error: [404, 'Access code not found'] };
      if (ac.status !== 'active') return { error: [410, `Code is ${ac.status}`] };
      if (new Date(ac.expires_at) < new Date()) {
        db.prepare(`UPDATE access_codes SET status = 'expired' WHERE id = ?`).run(ac.id);
        return { error: [410, 'Code has expired'] };
      }

      const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
      db.prepare(
        `UPDATE stores SET store_tier = ?, subscription_status = 'active', access_code_id = ?, locked = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
      ).run(ac.intended_tier || store.store_tier, ac.id, storeId);
      db.prepare(`UPDATE access_codes SET status = 'used', used_by_store = ? WHERE id = ?`).run(storeId, ac.id);

      return { ok: true };
    })();

    if (result.error) return res.status(result.error[0]).json({ error: result.error[1] });
    res.json({ message: 'Store activated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Redemption failed' });
  }
}

// GET /api/super/users?storeId=&role=&status=
// A true cross-store roster — previously the Super Admin could only see a
// per-store user *count* on the Manage Stores list; there was no way to
// actually see or act on an individual admin/manager/staff account without
// logging into that store. This is what "manages all admin accounts and
// users" needs: every user, across every store, in one place.
function listAllUsers(req, res) {
  const { storeId, role, status } = req.query;
  const clauses = [];
  const params = [];
  if (storeId) { clauses.push('u.store_id = ?'); params.push(storeId); }
  if (role) { clauses.push('u.role = ?'); params.push(role); }
  if (status) { clauses.push('u.status = ?'); params.push(status); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  res.json(db.prepare(
    `SELECT u.id, u.name, u.email, u.role, u.status, u.created_at, s.id AS store_id, s.name AS store_name
     FROM users u JOIN stores s ON s.id = u.store_id
     ${where} ORDER BY s.name ASC, u.created_at DESC`
  ).all(...params));
}

// PATCH /api/super/users/:id  { status }
function updateAnyUserStatus(req, res) {
  const { id } = req.params;
  const { status } = req.body;
  if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const info = db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
  if (info.changes === 0) return res.status(404).json({ error: 'User not found' });
  res.json(db.prepare('SELECT id, name, email, role, status FROM users WHERE id = ?').get(id));
}

// DELETE /api/super/users/:id
// Refuses to delete the last remaining admin of a store — that would
// leave the store with no one able to manage it (short of the Super Admin
// creating a new admin from Manage Stores).
function deleteAnyUser(req, res) {
  const { id } = req.params;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'admin') {
    const { count } = db.prepare(`SELECT COUNT(*) AS count FROM users WHERE store_id = ? AND role = 'admin'`).get(target.store_id);
    if (count <= 1) return res.status(400).json({ error: 'Cannot delete the last admin of a store' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.status(204).end();
}

const { cloudClientOrError, forwardError } = require('./cloudProxyHelpers');

// GET /api/stores/:storeId/marketplace-profile — proxied to the cloud,
// same reasoning as marketplaceController.js's header: this is data the
// public customer-facing directory reads, which only the cloud serves.
async function getMarketplaceProfile(req, res) {
  const cloud = cloudClientOrError(res);
  if (!cloud) return;
  try {
    const axios = require('axios');
    const { data } = await axios.get(`${cloud.baseUrl}/api/stores/${cloud.storeId}/marketplace-profile`, {
      headers: cloud.headers, timeout: 10000,
    });
    res.json(data);
  } catch (err) { forwardError(err, res); }
}

// PATCH /api/stores/:storeId/marketplace-profile  { category?, address?, city?, marketplaceEnabled? }
async function updateMarketplaceProfile(req, res) {
  const cloud = cloudClientOrError(res);
  if (!cloud) return;
  try {
    const axios = require('axios');
    const { data } = await axios.patch(
      `${cloud.baseUrl}/api/stores/${cloud.storeId}/marketplace-profile`, req.body,
      { headers: cloud.headers, timeout: 10000 }
    );
    res.json(data);
  } catch (err) { forwardError(err, res); }
}

// GET /api/super/referrals — SQLite twin of backend's, same rationale
// (see backend/src/controllers/storesController.js's listReferrals).
function listReferrals(req, res) {
  const referrers = db.prepare(
    `SELECT referral_contact,
            COUNT(*) AS total_signups,
            SUM(CASE WHEN subscription_status = 'active' THEN 1 ELSE 0 END) AS active_stores,
            SUM(CASE WHEN subscription_status = 'pending' THEN 1 ELSE 0 END) AS pending_stores,
            SUM(CASE WHEN subscription_status = 'suspended' THEN 1 ELSE 0 END) AS suspended_stores,
            MIN(created_at) AS first_referral_at,
            MAX(created_at) AS last_referral_at
     FROM stores
     WHERE referral_contact IS NOT NULL AND trim(referral_contact) != ''
     GROUP BY referral_contact
     ORDER BY active_stores DESC, total_signups DESC`
  ).all();
  const stores = db.prepare(
    `SELECT id, name, referral_contact, subscription_status, created_at FROM stores
     WHERE referral_contact IS NOT NULL AND trim(referral_contact) != ''
     ORDER BY created_at DESC`
  ).all();
  res.json({
    referrers: referrers.map((r) => ({
      referralContact: r.referral_contact,
      totalSignups: r.total_signups,
      activeStores: r.active_stores,
      pendingStores: r.pending_stores,
      suspendedStores: r.suspended_stores,
      firstReferralAt: r.first_referral_at,
      lastReferralAt: r.last_referral_at,
    })),
    stores,
  });
}

module.exports = {
  listStores, listReferrals, createStore, updateStore, activateStore, suspendStore, deleteStore, listPlans,
  generateCode, listCodes, revokeCode, redeemCode,
  listAllUsers, updateAnyUserStatus, deleteAnyUser,
  getMarketplaceProfile, updateMarketplaceProfile,
};
