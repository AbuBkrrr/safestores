const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../config/db');

const VALID_TYPES = ['bank', 'microfinance', 'lending_app', 'other'];

// ------------------------------------------------------------
// Super admin: manage partners
// ------------------------------------------------------------

// GET /api/super/lending-partners
async function listPartners(req, res) {
  const { rows } = await db.query(
    `SELECT lp.*,
            (SELECT COUNT(*) FROM store_lending_consents c WHERE c.lending_partner_id = lp.id AND c.revoked_at IS NULL) AS consenting_store_count
     FROM lending_partners lp ORDER BY lp.created_at DESC`
  );
  res.json(rows.map(({ api_key_hash, ...rest }) => rest)); // the hash never leaves the server, even to a super admin
}

// POST /api/super/lending-partners  { name, type, contactName?, contactEmail?, contactPhone? }
// Returns the real API key ONCE, at creation time — same pattern as
// webhooks.secret and access codes. There is no "show it again" later;
// losing it means generating a new one (see regenerateApiKey below).
async function createPartner(req, res) {
  const { name, type, contactName, contactEmail, contactPhone } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'name and type are required' });
  if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });

  const apiKey = crypto.randomBytes(32).toString('hex');
  const apiKeyHash = await bcrypt.hash(apiKey, 10);
  const { rows } = await db.query(
    `INSERT INTO lending_partners (name, type, contact_name, contact_email, contact_phone, api_key_hash)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, type, contact_name, contact_email, contact_phone, status, created_at`,
    [name, type, contactName || null, contactEmail || null, contactPhone || null, apiKeyHash]
  );
  res.status(201).json({ ...rows[0], apiKey });
}

// PATCH /api/super/lending-partners/:id  { status }
async function updatePartnerStatus(req, res) {
  const { id } = req.params;
  const { status } = req.body;
  if (!['pending', 'active', 'suspended'].includes(status)) {
    return res.status(400).json({ error: 'status must be one of: pending, active, suspended' });
  }
  const { rows } = await db.query(
    `UPDATE lending_partners SET status = $1, updated_at = now() WHERE id = $2
     RETURNING id, name, type, status`,
    [status, id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Partner not found' });
  res.json(rows[0]);
}

// POST /api/super/lending-partners/:id/regenerate-key
// Invalidates the old key immediately — a partner who lost their key
// (or one you suspect is compromised) gets a fresh one; the old one
// stops working the instant this runs, since it's not stored anywhere
// to compare against anymore.
async function regenerateApiKey(req, res) {
  const { id } = req.params;
  const apiKey = crypto.randomBytes(32).toString('hex');
  const apiKeyHash = await bcrypt.hash(apiKey, 10);
  const { rows } = await db.query(
    `UPDATE lending_partners SET api_key_hash = $1, updated_at = now() WHERE id = $2 RETURNING id, name`,
    [apiKeyHash, id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Partner not found' });
  res.json({ ...rows[0], apiKey });
}

// ------------------------------------------------------------
// Store admin: see available partners, opt in / out
// ------------------------------------------------------------

// GET /api/stores/:storeId/lending-partners
async function listAvailablePartners(req, res) {
  const { storeId } = req.params;
  const { rows } = await db.query(
    `SELECT lp.id, lp.name, lp.type, lp.contact_email,
            (c.id IS NOT NULL AND c.revoked_at IS NULL) AS consented
     FROM lending_partners lp
     LEFT JOIN store_lending_consents c ON c.lending_partner_id = lp.id AND c.store_id = $1
     WHERE lp.status = 'active'
     ORDER BY lp.name`,
    [storeId]
  );
  res.json(rows);
}

// POST /api/stores/:storeId/lending-partners/:partnerId/consent
async function grantConsent(req, res) {
  const { storeId, partnerId } = req.params;
  const { rows: partnerRows } = await db.query(`SELECT id FROM lending_partners WHERE id = $1 AND status = 'active'`, [partnerId]);
  if (!partnerRows[0]) return res.status(404).json({ error: 'Partner not found or not active' });

  await db.query(
    `INSERT INTO store_lending_consents (store_id, lending_partner_id) VALUES ($1,$2)
     ON CONFLICT (store_id, lending_partner_id) DO UPDATE SET consented_at = now(), revoked_at = NULL`,
    [storeId, partnerId]
  );
  res.status(204).end();
}

// DELETE /api/stores/:storeId/lending-partners/:partnerId/consent
async function revokeConsent(req, res) {
  const { storeId, partnerId } = req.params;
  const { rows } = await db.query(
    `UPDATE store_lending_consents SET revoked_at = now()
     WHERE store_id = $1 AND lending_partner_id = $2 AND revoked_at IS NULL RETURNING id`,
    [storeId, partnerId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No active consent found for this partner' });
  res.status(204).end();
}

// ------------------------------------------------------------
// Partner-facing API — authenticated via requireLendingPartnerKey, not a
// store/user JWT. Only ever returns AGGREGATE numbers for stores that
// have actively consented (and not since revoked) — never a line-item
// transaction list, never any data for a non-consenting store, and
// never anything at all if the partner has no consenting stores yet.
// ------------------------------------------------------------

// GET /api/lending/stores — every store currently consenting to THIS partner
async function listConsentingStores(req, res) {
  const partnerId = req.lendingPartner.id;
  const { rows } = await db.query(
    `SELECT s.id AS store_id, s.name, s.city, s.category, c.consented_at
     FROM store_lending_consents c
     JOIN stores s ON s.id = c.store_id
     WHERE c.lending_partner_id = $1 AND c.revoked_at IS NULL
     ORDER BY c.consented_at DESC`,
    [partnerId]
  );
  res.json(rows);
}

// GET /api/lending/stores/:storeId/summary — an aggregate financial
// summary a partner can use to underwrite a loan: months active,
// monthly revenue trend, order counts. No individual transactions, no
// customer names, no product-level detail.
async function getStoreSummary(req, res) {
  const partnerId = req.lendingPartner.id;
  const { storeId } = req.params;

  const { rows: consentRows } = await db.query(
    `SELECT 1 FROM store_lending_consents WHERE store_id = $1 AND lending_partner_id = $2 AND revoked_at IS NULL`,
    [storeId, partnerId]
  );
  if (!consentRows[0]) return res.status(403).json({ error: 'This store has not consented to share data with your organization' });

  const { rows: storeRows } = await db.query('SELECT name, created_at FROM stores WHERE id = $1', [storeId]);
  if (!storeRows[0]) return res.status(404).json({ error: 'Store not found' });

  const { rows: monthly } = await db.query(
    `SELECT to_char(date_trunc('month', paid_at), 'YYYY-MM') AS month,
            COUNT(*) AS order_count, SUM(total) AS revenue
     FROM orders
     WHERE store_id = $1 AND status = 'paid' AND paid_at >= now() - interval '12 months'
     GROUP BY 1 ORDER BY 1`,
    [storeId]
  );

  const monthsActive = Math.max(1, Math.floor((Date.now() - new Date(storeRows[0].created_at).getTime()) / (1000 * 60 * 60 * 24 * 30)));
  const totalRevenue12mo = monthly.reduce((sum, m) => sum + Number(m.revenue), 0);

  res.json({
    storeName: storeRows[0].name,
    monthsActiveOnPlatform: monthsActive,
    last12MonthsRevenue: totalRevenue12mo,
    averageMonthlyRevenue: monthly.length ? Math.round((totalRevenue12mo / monthly.length) * 100) / 100 : 0,
    monthlyBreakdown: monthly,
  });
}

module.exports = {
  listPartners, createPartner, updatePartnerStatus, regenerateApiKey,
  listAvailablePartners, grantConsent, revokeConsent,
  listConsentingStores, getStoreSummary,
};
