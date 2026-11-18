const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { generateAccessCode } = require('../utils/codes');

const VALID_TIERS = ['mini', 'midi', 'mega'];
const VALID_BILLING_MODELS = ['daily_percentage', 'custom'];

// GET /api/super/stores
async function listStores(req, res) {
  const { rows } = await db.query(
    `SELECT s.*, t.label AS tier_label,
            (SELECT COUNT(*) FROM users u WHERE u.store_id = s.id) AS user_count,
            (SELECT COUNT(*) FROM products pr WHERE pr.store_id = s.id) AS product_count
     FROM stores s LEFT JOIN store_tiers t ON t.tier = s.store_tier
     ORDER BY s.created_at DESC`
  );
  res.json(rows);
}

// GET /api/super/referrals
// Groups stores by referral_contact (the marketer/affiliate email or phone
// captured at signup — see 023_referral_tracking.sql) so a Super Admin can
// see how many stores each referrer brought in, and how many of those
// actually converted to paying customers, before deciding a bonus. Not a
// payout engine — just the counts a human needs to decide with.
async function listReferrals(req, res) {
  const { rows } = await db.query(
    `SELECT referral_contact,
            COUNT(*) AS total_signups,
            COUNT(*) FILTER (WHERE subscription_status = 'active') AS active_stores,
            COUNT(*) FILTER (WHERE subscription_status = 'pending') AS pending_stores,
            COUNT(*) FILTER (WHERE subscription_status = 'suspended') AS suspended_stores,
            MIN(created_at) AS first_referral_at,
            MAX(created_at) AS last_referral_at
     FROM stores
     WHERE referral_contact IS NOT NULL AND btrim(referral_contact) <> ''
     GROUP BY referral_contact
     ORDER BY active_stores DESC, total_signups DESC`
  );
  const { rows: stores } = await db.query(
    `SELECT id, name, referral_contact, subscription_status, created_at FROM stores
     WHERE referral_contact IS NOT NULL AND btrim(referral_contact) <> ''
     ORDER BY created_at DESC`
  );
  res.json({
    referrers: rows.map((r) => ({
      referralContact: r.referral_contact,
      totalSignups: Number(r.total_signups),
      activeStores: Number(r.active_stores),
      pendingStores: Number(r.pending_stores),
      suspendedStores: Number(r.suspended_stores),
      firstReferralAt: r.first_referral_at,
      lastReferralAt: r.last_referral_at,
    })),
    stores,
  });
}

// POST /api/super/stores
// body: { storeName, adminName, adminEmail, password, storeTier?, billingModel?, dailyRatePercent?, gracePeriodMinutes?, customBillingNotes? }
// Lets the Super Admin create a store (and its first admin user) directly,
// bypassing the public self-signup flow — the store is created already
// active, with whatever tier/billing the Super Admin chooses up front.
// See desktop/server/controllers/storesController.js's createStore for
// the SQLite counterpart — same behavior, different transaction API.
async function createStore(req, res) {
  const {
    storeName, adminName, adminEmail, password,
    storeTier, billingModel, dailyRatePercent, gracePeriodMinutes, customBillingNotes,
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

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const passwordHash = await bcrypt.hash(password, 10);

    const storeRes = await client.query(
      `INSERT INTO stores (name, store_tier, subscription_status, billing_model, daily_rate_percent, grace_period_minutes, custom_billing_notes)
       VALUES ($1, $2, 'active', $3, $4, $5, $6) RETURNING *`,
      [storeName, storeTier || 'mini', billingModel || 'daily_percentage', dailyRatePercent ?? 1.0, gracePeriodMinutes ?? 5, customBillingNotes || null]
    );
    const store = storeRes.rows[0];

    const userRes = await client.query(
      `INSERT INTO users (store_id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, 'admin')
       RETURNING id, name, email, role`,
      [store.id, adminName, adminEmail, passwordHash]
    );

    await client.query('COMMIT');
    res.status(201).json({ store, admin: userRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Email already in use for this store' });
    console.error(err);
    res.status(500).json({ error: 'Failed to create store' });
  } finally {
    client.release();
  }
}

// PATCH /api/super/stores/:id
// body: any of { name, storeTier, subscriptionStatus, billingModel, dailyRatePercent, gracePeriodMinutes, customBillingNotes, locked }
// General-purpose edit — tier corrections, subscription status, billing
// terms, and lock overrides all go through here from Manage Stores.
async function updateStore(req, res) {
  const { id } = req.params;
  const {
    name, storeTier, subscriptionStatus, billingModel,
    dailyRatePercent, gracePeriodMinutes, customBillingNotes, locked,
    // Whether this store appears in the customer-facing marketplace
    // directory at all — deliberately a Super Admin-only switch, not
    // something a store can flip for itself (see routes/marketplace.js's
    // listStores/searchProducts, both of which require this to be true).
    marketplaceEnabled,
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

  const { rows } = await db.query(
    `UPDATE stores SET
       name = COALESCE($1, name),
       store_tier = COALESCE($2, store_tier),
       subscription_status = COALESCE($3, subscription_status),
       billing_model = COALESCE($4, billing_model),
       daily_rate_percent = COALESCE($5, daily_rate_percent),
       grace_period_minutes = COALESCE($6, grace_period_minutes),
       custom_billing_notes = CASE WHEN $7::boolean THEN $8 ELSE custom_billing_notes END,
       locked = COALESCE($9, locked),
       marketplace_enabled = COALESCE($10, marketplace_enabled),
       updated_at = now()
     WHERE id = $11 RETURNING *`,
    [
      name || null, storeTier || null, subscriptionStatus || null, billingModel || null,
      dailyRatePercent ?? null, gracePeriodMinutes ?? null,
      customBillingNotes !== undefined, customBillingNotes ?? null,
      locked !== undefined ? !!locked : null,
      marketplaceEnabled !== undefined ? !!marketplaceEnabled : null,
      id,
    ]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Store not found' });
  res.json(rows[0]);
}

// PATCH /api/super/stores/:id/activate
// body: { storeTier, billingModel, dailyRatePercent?, customBillingNotes? }
// This is where the Super Admin assigns the store's size category
// (mini/midi/mega) and billing model — not chosen by the store at signup.
async function activateStore(req, res) {
  const { id } = req.params;
  const { storeTier, billingModel, dailyRatePercent, customBillingNotes, gracePeriodMinutes } = req.body;

  if (storeTier && !['mini', 'midi', 'mega'].includes(storeTier)) {
    return res.status(400).json({ error: 'storeTier must be mini, midi, or mega' });
  }
  if (billingModel && !['daily_percentage', 'custom'].includes(billingModel)) {
    return res.status(400).json({ error: 'billingModel must be daily_percentage or custom' });
  }

  const { rows } = await db.query(
    `UPDATE stores SET
       subscription_status = 'active',
       store_tier = COALESCE($1, store_tier),
       billing_model = COALESCE($2, billing_model),
       daily_rate_percent = COALESCE($3, daily_rate_percent),
       grace_period_minutes = COALESCE($4, grace_period_minutes),
       custom_billing_notes = COALESCE($5, custom_billing_notes),
       locked = false,
       updated_at = now()
     WHERE id = $6 RETURNING *`,
    [storeTier || null, billingModel || null, dailyRatePercent || null, gracePeriodMinutes || null, customBillingNotes || null, id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Store not found' });
  res.json(rows[0]);
}

// PATCH /api/super/stores/:id/suspend
async function suspendStore(req, res) {
  const { id } = req.params;
  const { rows } = await db.query(
    `UPDATE stores SET subscription_status = 'suspended', updated_at = now() WHERE id = $1 RETURNING *`,
    [id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Store not found' });
  res.json(rows[0]);
  require('../utils/activityLog').logActivity(req, { storeId: id, action: 'store.suspended', entityType: 'store', entityId: id });
}

// DELETE /api/super/stores/:id
async function deleteStore(req, res) {
  const { id } = req.params;
  const { rowCount } = await db.query('DELETE FROM stores WHERE id = $1', [id]);
  if (!rowCount) return res.status(404).json({ error: 'Store not found' });
  res.status(204).end();
}

// GET /api/super/tiers — store size categories (mini/midi/mega) and their limits
async function listPlans(req, res) {
  const { rows } = await db.query('SELECT * FROM store_tiers ORDER BY tier ASC');
  res.json(rows);
}

// ------------------------------------------------------------
// Access codes
// ------------------------------------------------------------

// POST /api/super/access-codes  { intendedTier? }
async function generateCode(req, res) {
  const { intendedTier } = req.body;
  if (intendedTier && !['mini', 'midi', 'mega'].includes(intendedTier)) {
    return res.status(400).json({ error: 'intendedTier must be mini, midi, or mega' });
  }

  const code = generateAccessCode();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  const { rows } = await db.query(
    `INSERT INTO access_codes (code, intended_tier, issued_by, expires_at)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [code, intendedTier || null, req.user.sub, expiresAt]
  );
  res.status(201).json(rows[0]);
}

// GET /api/super/access-codes
async function listCodes(req, res) {
  const { rows } = await db.query(
    `SELECT ac.*, s.name AS store_name
     FROM access_codes ac
     LEFT JOIN stores s ON s.id = ac.used_by_store
     ORDER BY ac.created_at DESC`
  );
  res.json(rows);
}

// PATCH /api/super/access-codes/:id/revoke
async function revokeCode(req, res) {
  const { id } = req.params;
  const { rows } = await db.query(
    `UPDATE access_codes SET status = 'revoked' WHERE id = $1 AND status = 'active' RETURNING *`,
    [id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Active code not found' });
  res.json(rows[0]);
}

// POST /api/stores/:storeId/redeem-code   { code }
// Called by a (pending) store admin to activate their store's subscription.
async function redeemCode(req, res) {
  const { storeId } = req.params;
  const { code } = req.body;

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM access_codes WHERE code = $1 FOR UPDATE`,
      [code]
    );
    const ac = rows[0];
    if (!ac) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Access code not found' }); }
    if (ac.status !== 'active') { await client.query('ROLLBACK'); return res.status(410).json({ error: `Code is ${ac.status}` }); }
    if (new Date(ac.expires_at) < new Date()) {
      await client.query(`UPDATE access_codes SET status = 'expired' WHERE id = $1`, [ac.id]);
      await client.query('COMMIT');
      return res.status(410).json({ error: 'Code has expired' });
    }

    await client.query(
      `UPDATE stores SET
         store_tier = COALESCE($1, store_tier),
         subscription_status = 'active', access_code_id = $2, locked = false, updated_at = now()
       WHERE id = $3`,
      [ac.intended_tier, ac.id, storeId]
    );
    await client.query(
      `UPDATE access_codes SET status = 'used', used_by_store = $1 WHERE id = $2`,
      [storeId, ac.id]
    );
    await client.query('COMMIT');
    res.json({ message: 'Store activated successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Redemption failed' });
  } finally {
    client.release();
  }
}

// GET /api/super/users?storeId=&role=&status=
// See desktop/server/controllers/storesController.js's listAllUsers for
// the full rationale.
async function listAllUsers(req, res) {
  const { storeId, role, status } = req.query;
  const clauses = [];
  const params = [];
  if (storeId) { params.push(storeId); clauses.push(`u.store_id = $${params.length}`); }
  if (role) { params.push(role); clauses.push(`u.role = $${params.length}`); }
  if (status) { params.push(status); clauses.push(`u.status = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.email, u.role, u.status, u.created_at, s.id AS store_id, s.name AS store_name
     FROM users u JOIN stores s ON s.id = u.store_id
     ${where} ORDER BY s.name ASC, u.created_at DESC`,
    params
  );
  res.json(rows);
}

// PATCH /api/super/users/:id  { status }
async function updateAnyUserStatus(req, res) {
  const { id } = req.params;
  const { status } = req.body;
  if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const { rows } = await db.query(
    'UPDATE users SET status = $1 WHERE id = $2 RETURNING id, name, email, role, status',
    [status, id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
}

// DELETE /api/super/users/:id — refuses to delete a store's last admin.
async function deleteAnyUser(req, res) {
  const { id } = req.params;
  const targetRes = await db.query('SELECT * FROM users WHERE id = $1', [id]);
  const target = targetRes.rows[0];
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'admin') {
    const countRes = await db.query(`SELECT COUNT(*) AS count FROM users WHERE store_id = $1 AND role = 'admin'`, [target.store_id]);
    if (Number(countRes.rows[0].count) <= 1) return res.status(400).json({ error: 'Cannot delete the last admin of a store' });
  }
  await db.query('DELETE FROM users WHERE id = $1', [id]);
  res.status(204).end();
}

// GET /api/stores/:storeId/marketplace-profile
// PATCH /api/stores/:storeId/marketplace-profile  { category?, address?, city? }
// Reachable via a real per-user JWT (web) or the store sync key (desktop
// proxy, and desktop's own setup wizard validating a Store ID/Sync Key
// pair before any admin is even logged in) — see the route registration's
// comment in routes/stores.js. Whether the store is actually visible at
// all (marketplace_enabled) is deliberately NOT settable here — that's a
// Super Admin-only switch (see storesController's updateStore) toggled
// from the Super Admin dashboard, not something a store can flip for itself.
async function getMarketplaceProfile(req, res) {
  const { storeId } = req.params;
  const { rows } = await db.query(
    'SELECT id, name, category, address, city, marketplace_enabled FROM stores WHERE id = $1', [storeId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Store not found' });
  res.json(rows[0]);
}

async function updateMarketplaceProfile(req, res) {
  const { storeId } = req.params;
  const { category, address, city } = req.body;
  const { rows } = await db.query(
    `UPDATE stores SET category = COALESCE($1, category), address = COALESCE($2, address),
            city = COALESCE($3, city), updated_at = now()
     WHERE id = $4 RETURNING id, name, category, address, city, marketplace_enabled`,
    [category ?? null, address ?? null, city ?? null, storeId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Store not found' });
  res.json(rows[0]);
}

// GET/PATCH /api/stores/:storeId/loyalty-settings
// A store's own "every Nth order gets a discount" rule for their public
// storefront — deliberately simple, one rule per store (see migration
// 027's header comment for why).
async function getLoyaltySettings(req, res) {
  const { storeId } = req.params;
  const { rows } = await db.query(
    'SELECT loyalty_enabled, loyalty_every_nth_order, loyalty_discount_pct FROM stores WHERE id = $1', [storeId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Store not found' });
  res.json(rows[0]);
}

async function updateLoyaltySettings(req, res) {
  const { storeId } = req.params;
  const { loyaltyEnabled, everyNthOrder, discountPct } = req.body;
  if (everyNthOrder !== undefined && Number(everyNthOrder) < 2) {
    return res.status(400).json({ error: 'everyNthOrder must be at least 2' });
  }
  if (discountPct !== undefined && (Number(discountPct) <= 0 || Number(discountPct) > 100)) {
    return res.status(400).json({ error: 'discountPct must be between 0 and 100' });
  }
  const { rows } = await db.query(
    `UPDATE stores SET
       loyalty_enabled = COALESCE($1, loyalty_enabled),
       loyalty_every_nth_order = COALESCE($2, loyalty_every_nth_order),
       loyalty_discount_pct = COALESCE($3, loyalty_discount_pct),
       updated_at = now()
     WHERE id = $4 RETURNING loyalty_enabled, loyalty_every_nth_order, loyalty_discount_pct`,
    [typeof loyaltyEnabled === 'boolean' ? loyaltyEnabled : null, everyNthOrder ?? null, discountPct ?? null, storeId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Store not found' });
  res.json(rows[0]);
}

module.exports = {
  listStores, listReferrals, createStore, updateStore, activateStore, suspendStore, deleteStore, listPlans,
  generateCode, listCodes, revokeCode, redeemCode,
  listAllUsers, updateAnyUserStatus, deleteAnyUser,
  getMarketplaceProfile, updateMarketplaceProfile,
  getLoyaltySettings, updateLoyaltySettings,
};
