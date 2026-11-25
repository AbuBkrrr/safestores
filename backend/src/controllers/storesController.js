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
            (SELECT COUNT(*) FROM products pr WHERE pr.store_id = s.id) AS product_count,
            (SELECT ac.code FROM access_codes ac WHERE ac.issued_for_store = s.id OR ac.used_by_store = s.id ORDER BY ac.created_at DESC LIMIT 1) AS access_code,
            (SELECT ac.status FROM access_codes ac WHERE ac.issued_for_store = s.id OR ac.used_by_store = s.id ORDER BY ac.created_at DESC LIMIT 1) AS access_code_status,
            (SELECT ac.expires_at FROM access_codes ac WHERE ac.issued_for_store = s.id OR ac.used_by_store = s.id ORDER BY ac.created_at DESC LIMIT 1) AS access_code_expires_at,
            (SELECT st.created_at FROM support_tickets st WHERE st.store_id = s.id AND st.subject = 'Activation key request' AND st.status IN ('open','in_progress') ORDER BY st.created_at DESC LIMIT 1) AS key_requested_at
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
    storeTier, billingModel, dailyRatePercent, gracePeriodMinutes, customBillingNotes, businessType,
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
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const passwordHash = await bcrypt.hash(password, 10);

    const storeRes = await client.query(
      `INSERT INTO stores (name, store_tier, subscription_status, billing_model, daily_rate_percent, grace_period_minutes, custom_billing_notes)
       VALUES ($1, $2, 'active', $3, $4, $5, $6) RETURNING *`,
      [storeName, storeTier || 'mini', billingModel || 'daily_percentage', dailyRatePercent ?? 1.0, gracePeriodMinutes ?? 5, customBillingNotes || null]
    );
    let store = storeRes.rows[0];
    if (require('../utils/businessTypes').TYPE_KEYS.includes(businessType)) {
      store = (await client.query('UPDATE stores SET business_type = $1 WHERE id = $2 RETURNING *', [businessType, store.id])).rows[0];
    }
    // Created already active, so its code is recorded as used.
    await issueStoreCode(client, { storeId: store.id, tier: store.store_tier, issuedBy: req.user.sub, used: true });

    const userRes = await client.query(
      `INSERT INTO users (store_id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, 'admin')
       RETURNING id, name, email, role`,
      [store.id, adminName, adminEmail, passwordHash]
    );

    await client.query('COMMIT');
    // The store's own Windows and Android apps (never blocks creation).
    require('../utils/storeApps').requestBuild(store).catch(() => {});
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
  // Make sure an activated store has its own apps (built once; retried if
  // building wasn't set up yet or the last try failed).
  require('../utils/storeApps').ensureBuilt(rows[0]).catch(() => {});
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

// PUT /api/super/tiers/:tier  { label?, maxProducts, maxUsers }  (null/'' = unlimited)
async function updateTier(req, res) {
  const parsed = parseTierLimits(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { rows } = await db.query(
    `UPDATE store_tiers SET label = COALESCE($1, label), max_products = $2, max_users = $3 WHERE tier = $4 RETURNING *`,
    [parsed.label, parsed.maxProducts, parsed.maxUsers, req.params.tier]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Tier not found' });
  res.json(rows[0]);
}

// POST /api/super/stores/:id/access-code  { expiresInDays? } — a fresh code for one store
async function issueCodeForStore(req, res) {
  const days = parseExpiryDays(req.body.expiresInDays);
  if (days.error) return res.status(400).json({ error: days.error });
  const { rows } = await db.query('SELECT id, store_tier, requested_tier, subscription_status FROM stores WHERE id = $1', [req.params.id]);
  const store = rows[0];
  if (!store) return res.status(404).json({ error: 'Store not found' });
  // Any older unused code for this store stops working.
  await db.query(`UPDATE access_codes SET status = 'revoked' WHERE issued_for_store = $1 AND status = 'active'`, [store.id]);
  const code = await issueStoreCode(db, {
    storeId: store.id, tier: store.requested_tier || store.store_tier, issuedBy: req.user.sub, days: days.value,
  });
  // Sent to the owner straight away: their activation screen and their email.
  const emailedTo = await require('./activationController').deliverKey(store.id, code).catch(() => []);
  res.status(201).json({ ...code, emailedTo });
}

// ------------------------------------------------------------
// Access codes
// ------------------------------------------------------------

const { parseExpiryDays, parseTierLimits } = require('../utils/codeRules');

// Creates the access code that belongs to one store. `q` is the db or a
// transaction client. `used` marks it redeemed (store created already active).
async function issueStoreCode(q, { storeId, tier, issuedBy = null, used = false, days = 30 }) {
  const { rows } = await q.query(
    `INSERT INTO access_codes (code, intended_tier, issued_by, status, used_by_store, issued_for_store, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [generateAccessCode(), ['mini', 'midi', 'mega'].includes(tier) ? tier : null, issuedBy,
      used ? 'used' : 'active', used ? storeId : null, storeId, new Date(Date.now() + days * 86400000)]
  );
  return rows[0];
}

// POST /api/super/access-codes  { intendedTier? }
async function generateCode(req, res) {
  const { intendedTier } = req.body;
  if (intendedTier && !['mini', 'midi', 'mega'].includes(intendedTier)) {
    return res.status(400).json({ error: 'intendedTier must be mini, midi, or mega' });
  }
  const days = parseExpiryDays(req.body.expiresInDays);
  if (days.error) return res.status(400).json({ error: days.error });

  const code = generateAccessCode();
  const expiresAt = new Date(Date.now() + days.value * 24 * 60 * 60 * 1000);

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
     LEFT JOIN stores s ON s.id = COALESCE(ac.used_by_store, ac.issued_for_store)
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
    if (ac.issued_for_store && ac.issued_for_store !== storeId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This access code was issued for a different store' });
    }
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
const SHOP_FONTS = ['Poppins', 'Montserrat', 'Nunito', 'Playfair Display', 'Merriweather', 'Lobster', 'Oswald', 'Quicksand'];

async function getMarketplaceProfile(req, res) {
  const { storeId } = req.params;
  const { rows } = await db.query(
    'SELECT id, name, category, address, city, marketplace_enabled, shop_slug, shop_tagline, custom_domain, shop_logo_url, shop_bg_image_url, shop_brand_color, shop_bg_color, shop_font, shop_theme FROM stores WHERE id = $1', [storeId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Store not found' });
  res.json({ ...rows[0], domain_target: require('../utils/customDomain').domainTarget() });
}

async function updateMarketplaceProfile(req, res) {
  const { storeId } = req.params;
  const { category, address, city, shopSlug, shopTagline, customDomain } = req.body;
  // Branding: undefined = leave, '' = reset to default. Colours are #rrggbb; fonts/themes from fixed lists.
  const HEX = /^#[0-9a-f]{6}$/i;
  const brand = {};
  for (const [key, col] of [['brandColor', 'shop_brand_color'], ['bgColor', 'shop_bg_color']]) {
    const v = req.body[key];
    if (v === undefined) continue;
    if (v && !HEX.test(v)) return res.status(400).json({ error: 'Colours must look like #1a2b3c' });
    brand[col] = v || null;
  }
  if (req.body.font !== undefined) {
    if (req.body.font && !SHOP_FONTS.includes(req.body.font)) return res.status(400).json({ error: 'Unknown font' });
    brand.shop_font = req.body.font || null;
  }
  if (req.body.theme !== undefined) {
    if (req.body.theme && !['light', 'dark'].includes(req.body.theme)) return res.status(400).json({ error: 'theme must be light or dark' });
    brand.shop_theme = req.body.theme || null;
  }
  // Images are set through the upload endpoint; here they can only be cleared.
  for (const [key, col] of [['logoUrl', 'shop_logo_url'], ['bgImageUrl', 'shop_bg_image_url']]) {
    if (req.body[key] === '' || req.body[key] === null) brand[col] = null;
  }
  if (Object.keys(brand).length) {
    const cols = Object.keys(brand);
    await db.query(`UPDATE stores SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`, [storeId, ...cols.map((c) => brand[c])]);
  }
  const cd = require('../utils/customDomain');
  let domain;
  if (customDomain !== undefined) {
    const parsed = cd.parseCustomDomain(customDomain);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    domain = parsed.value;
    if (domain) {
      const taken = await db.query('SELECT 1 FROM stores WHERE custom_domain = $1 AND id <> $2', [domain, storeId]);
      if (taken.rowCount) return res.status(409).json({ error: 'That domain is already connected to another shop' });
    }
  }
  // shopSlug/shopTagline: undefined = leave as is, '' = clear.
  let slug;
  if (shopSlug !== undefined) {
    const parsed = require('../utils/shopSlug').parseShopSlug(shopSlug);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    slug = parsed.value;
    if (slug) {
      const taken = await db.query('SELECT 1 FROM stores WHERE shop_slug = $1 AND id <> $2', [slug, storeId]);
      if (taken.rowCount) return res.status(409).json({ error: 'That shop address is already taken — try adding your area, e.g. -lekki' });
    }
  }
  const tagline = shopTagline === undefined ? undefined : (String(shopTagline).trim().slice(0, 140) || null);
  const { rows } = await db.query(
    `UPDATE stores SET category = COALESCE($1, category), address = COALESCE($2, address),
            city = COALESCE($3, city),
            shop_slug = CASE WHEN $5 THEN $6 ELSE shop_slug END,
            shop_tagline = CASE WHEN $7 THEN $8 ELSE shop_tagline END,
            custom_domain = CASE WHEN $9 THEN $10 ELSE custom_domain END,
            updated_at = now()
     WHERE id = $4 RETURNING id, name, category, address, city, marketplace_enabled, shop_slug, shop_tagline, custom_domain, shop_logo_url, shop_bg_image_url, shop_brand_color, shop_bg_color, shop_font, shop_theme`,
    [category ?? null, address ?? null, city ?? null, storeId, slug !== undefined, slug ?? null, tagline !== undefined, tagline ?? null,
      domain !== undefined, domain ?? null]
  );
  if (domain !== undefined) cd.clearDomainCache();
  if (rows[0]) rows[0].domain_target = cd.domainTarget();
  if (!rows[0]) return res.status(404).json({ error: 'Store not found' });
  res.json(rows[0]);
}

// POST /api/stores/:storeId/branding/:kind  (multipart "image") — kind: logo | background
async function uploadBranding(req, res) {
  const col = { logo: 'shop_logo_url', background: 'shop_bg_image_url' }[req.params.kind];
  if (!col) return res.status(400).json({ error: 'kind must be logo or background' });
  if (!req.file) return res.status(400).json({ error: 'Choose an image' });
  const { url } = await require('../utils/storage').persistUpload(req.file, { keyPrefix: `stores/${req.params.storeId}/branding` });
  await db.query(`UPDATE stores SET ${col} = $1 WHERE id = $2`, [url, req.params.storeId]);
  res.json({ url });
}

// GET /api/stores/:storeId/custom-domain/check — is the store's domain's DNS pointed here yet?
async function checkCustomDomain(req, res) {
  const { rows } = await db.query('SELECT custom_domain FROM stores WHERE id = $1', [req.params.storeId]);
  const domain = rows[0]?.custom_domain;
  if (!domain) return res.status(404).json({ error: 'No custom domain set' });
  const cd = require('../utils/customDomain');
  res.json({ domain, pointsHere: await cd.dnsPointsHere(domain), target: cd.domainTarget() });
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
  uploadBranding,
  listStores, listReferrals, createStore, updateStore, activateStore, suspendStore, deleteStore, listPlans, updateTier, issueCodeForStore, issueStoreCode,
  generateCode, listCodes, revokeCode, redeemCode,
  listAllUsers, updateAnyUserStatus, deleteAnyUser,
  getMarketplaceProfile, updateMarketplaceProfile, checkCustomDomain,
  getLoyaltySettings, updateLoyaltySettings,
};
