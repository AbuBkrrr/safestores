const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { signToken } = require('../utils/jwt');
const { emitToStore } = require('../realtime');

// Partner portal: guarantors and couriers. A store invites a partner by
// email; the invite link creates (or links) a partner login.
const appUrl = () => (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim().replace(/\/$/, '');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const KINDS = ['guarantor', 'courier'];
const tokenFor = (p) => signToken({ sub: p.id, role: p.kind, storeId: null, tv: p.token_version || 0 });
const publicPartner = (p) => ({ id: p.id, name: p.name, email: p.email, phone: p.phone, role: p.kind });

// ---- Store side -----------------------------------------------------------

// POST /api/stores/:storeId/partner-invites  { kind, email, guarantorId? }
async function createInvite(req, res) {
  const { storeId } = req.params;
  const kind = req.body?.kind;
  const email = String(req.body?.email || '').trim().toLowerCase();
  const guarantorId = req.body?.guarantorId || null;
  if (!KINDS.includes(kind)) return res.status(400).json({ error: 'kind must be guarantor or courier' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'A valid email is required' });
  if (kind === 'guarantor') {
    const g = await db.query('SELECT id FROM credit_guarantors WHERE id = $1 AND store_id = $2', [guarantorId, storeId]);
    if (!g.rows[0]) return res.status(400).json({ error: 'Pick the guarantor to invite' });
  }
  const raw = crypto.randomBytes(24).toString('base64url');
  await db.query(
    `INSERT INTO partner_invites (token, store_id, kind, guarantor_id, email, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
    [sha256(raw), storeId, kind, kind === 'guarantor' ? guarantorId : null, email, req.user.sub || null]
  );
  res.status(201).json({ link: `${appUrl()}/partner/accept?token=${raw}`, email, kind });
}

// GET /api/stores/:storeId/couriers
async function listCouriers(req, res) {
  const { rows } = await db.query(
    `SELECT sc.id, sc.active, p.id AS partner_id, p.name, p.email, p.phone,
            (SELECT COUNT(*)::int FROM marketplace_orders mo WHERE mo.courier_id = p.id AND mo.store_id = sc.store_id
               AND mo.status IN ('confirmed','out_for_delivery')) AS open_jobs
     FROM store_couriers sc JOIN partners p ON p.id = sc.partner_id
     WHERE sc.store_id = $1 ORDER BY p.name`, [req.params.storeId]
  );
  res.json(rows);
}

// PATCH /api/stores/:storeId/couriers/:courierId  { active }
async function setCourierActive(req, res) {
  const { rows } = await db.query(
    'UPDATE store_couriers SET active = $1 WHERE id = $2 AND store_id = $3 RETURNING *',
    [!!req.body?.active, req.params.courierId, req.params.storeId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Courier not found' });
  res.json(rows[0]);
}

// PATCH /api/stores/:storeId/marketplace/orders/:orderId/courier  { courierId | null }
async function assignCourier(req, res) {
  const { storeId, orderId } = req.params;
  const partnerId = req.body?.courierId || null;
  if (partnerId) {
    const ok = await db.query('SELECT 1 FROM store_couriers WHERE store_id = $1 AND partner_id = $2 AND active', [storeId, partnerId]);
    if (!ok.rows[0]) return res.status(400).json({ error: 'That courier is not active for this store' });
  }
  const { rows } = await db.query(
    `UPDATE marketplace_orders SET courier_id = $1, courier_picked_at = NULL
     WHERE id = $2 AND store_id = $3 AND fulfilment_method = 'delivery' AND status IN ('confirmed','out_for_delivery') RETURNING id, courier_id`,
    [partnerId, orderId, storeId]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Only a confirmed delivery order can be given to a courier' });
  emitToStore(storeId, 'marketplace:order_updated', { id: orderId });
  res.json(rows[0]);
}

// ---- Public: accept invite / login ---------------------------------------

async function findInvite(raw) {
  const { rows } = await db.query(
    `SELECT pi.*, s.name AS store_name, g.name AS guarantor_name FROM partner_invites pi
     JOIN stores s ON s.id = pi.store_id LEFT JOIN credit_guarantors g ON g.id = pi.guarantor_id
     WHERE pi.token = $1`, [sha256(raw)]
  );
  const inv = rows[0];
  if (!inv) return { error: 'This invite link is not valid' };
  if (inv.accepted_at) return { error: 'This invite has already been used. Log in instead.' };
  if (new Date(inv.expires_at) < new Date()) return { error: 'This invite has expired. Ask the store for a new one.' };
  return { inv };
}

// GET /api/partner/invite/:token
async function getInvite(req, res) {
  const { inv, error } = await findInvite(req.params.token);
  if (error) return res.status(400).json({ error });
  const existing = await db.query('SELECT kind FROM partners WHERE email = $1', [inv.email]);
  res.json({ kind: inv.kind, email: inv.email, storeName: inv.store_name, guarantorName: inv.guarantor_name, hasAccount: !!existing.rows[0] });
}

// POST /api/partner/accept  { token, name?, phone?, password }
async function acceptInvite(req, res) {
  const { token, name, phone, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'token and password are required' });
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { inv, error } = await findInvite(token);
    if (error) { await client.query('ROLLBACK'); return res.status(400).json({ error }); }
    let partner = (await client.query('SELECT * FROM partners WHERE email = $1 FOR UPDATE', [inv.email])).rows[0];
    if (partner) {
      if (!(await bcrypt.compare(password, partner.password_hash))) { await client.query('ROLLBACK'); return res.status(401).json({ error: 'Wrong password for this partner account' }); }
      if (partner.kind !== inv.kind) { await client.query('ROLLBACK'); return res.status(400).json({ error: `This email is already a ${partner.kind} account` }); }
    } else {
      if (!name || String(password).length < 8) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Name and a password of at least 8 characters are required' }); }
      partner = (await client.query(
        `INSERT INTO partners (kind, name, email, phone, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [inv.kind, String(name).trim().slice(0, 150), inv.email, phone || null, await bcrypt.hash(password, 10)]
      )).rows[0];
    }
    if (inv.kind === 'guarantor') {
      await client.query('UPDATE credit_guarantors SET partner_id = $1 WHERE id = $2', [partner.id, inv.guarantor_id]);
    } else {
      await client.query(
        `INSERT INTO store_couriers (store_id, partner_id) VALUES ($1,$2) ON CONFLICT (store_id, partner_id) DO UPDATE SET active = true`,
        [inv.store_id, partner.id]
      );
    }
    await client.query('UPDATE partner_invites SET accepted_at = now() WHERE token = $1', [inv.token]);
    await client.query('COMMIT');
    res.json({ token: tokenFor(partner), user: publicPartner(partner) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not accept the invite' });
  } finally {
    client.release();
  }
}

// POST /api/auth/partner/login  { email, password }
async function partnerLogin(req, res) {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const { rows } = await db.query('SELECT * FROM partners WHERE email = $1', [email]);
  const p = rows[0];
  if (!p || !(await bcrypt.compare(String(req.body?.password || ''), p.password_hash))) return res.status(401).json({ error: 'Invalid credentials' });
  if (p.status !== 'active') return res.status(403).json({ error: 'This partner account is disabled.' });
  res.json({ token: tokenFor(p), user: publicPartner(p) });
}

// ---- Guarantor portal -----------------------------------------------------

// GET /api/partner/guarantor
async function guarantorOverview(req, res) {
  const pid = req.user.sub;
  const accounts = (await db.query(
    `SELECT ca.id, ca.status, ca.credit_limit, ca.requested_limit, ca.member_ref, ca.member_verified, ca.created_at,
            c.name AS customer_name, c.phone AS customer_phone, s.name AS store_name, g.name AS guarantor_name,
            (SELECT COALESCE(SUM(mo.total),0) FROM marketplace_orders mo WHERE mo.credit_account_id = ca.id
               AND mo.payment_method = 'credit' AND mo.status <> 'cancelled' AND mo.payment_status <> 'paid') AS used
     FROM credit_accounts ca JOIN credit_guarantors g ON g.id = ca.guarantor_id
     JOIN customers c ON c.id = ca.customer_id JOIN stores s ON s.id = ca.store_id
     WHERE g.partner_id = $1 ORDER BY (ca.status = 'pending') DESC, ca.created_at DESC`, [pid]
  )).rows;
  const owed = (await db.query(
    `SELECT mo.id, mo.total, mo.fulfilled_at, mo.guarantor_paid_ref, mo.guarantor_paid_reported_at,
            c.name AS customer_name, ca.member_ref, s.name AS store_name
     FROM marketplace_orders mo JOIN credit_accounts ca ON ca.id = mo.credit_account_id
     JOIN credit_guarantors g ON g.id = ca.guarantor_id JOIN customers c ON c.id = ca.customer_id JOIN stores s ON s.id = mo.store_id
     WHERE g.partner_id = $1 AND mo.payment_method = 'credit' AND mo.status = 'fulfilled' AND mo.payment_status <> 'paid'
     ORDER BY s.name, mo.fulfilled_at`, [pid]
  )).rows;
  res.json({ accounts, owed });
}

// PATCH /api/partner/guarantor/accounts/:id/verify  { verified }
async function verifyMember(req, res) {
  const { rows } = await db.query(
    `UPDATE credit_accounts ca SET member_verified = $1, member_verified_at = now()
     FROM credit_guarantors g WHERE g.id = ca.guarantor_id AND g.partner_id = $2 AND ca.id = $3 RETURNING ca.id, ca.store_id, ca.member_verified`,
    [!!req.body?.verified, req.user.sub, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Account not found' });
  emitToStore(rows[0].store_id, 'credit:applied', { id: rows[0].id });
  res.json(rows[0]);
}

// POST /api/partner/guarantor/orders/:id/report-payment  { reference }
async function reportPayment(req, res) {
  const ref = String(req.body?.reference || '').trim().slice(0, 120);
  if (!ref) return res.status(400).json({ error: 'Enter the payment reference' });
  const { rows } = await db.query(
    `UPDATE marketplace_orders mo SET guarantor_paid_ref = $1, guarantor_paid_reported_at = now()
     FROM credit_accounts ca JOIN credit_guarantors g ON g.id = ca.guarantor_id
     WHERE ca.id = mo.credit_account_id AND g.partner_id = $2 AND mo.id = $3 AND mo.payment_status <> 'paid'
     RETURNING mo.id, mo.store_id`, [ref, req.user.sub, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Order not found or already settled' });
  emitToStore(rows[0].store_id, 'marketplace:order_updated', { id: rows[0].id });
  res.json({ message: 'Payment reported. The store will confirm it.' });
}

// ---- Courier portal -------------------------------------------------------

// GET /api/partner/courier
async function courierJobs(req, res) {
  const { rows } = await db.query(
    `SELECT mo.id, mo.status, mo.total, mo.payment_method, mo.payment_status, mo.delivery_address, mo.customer_note,
            mo.courier_picked_at, mo.fulfilled_at, mo.created_at,
            COALESCE(c.name, mo.guest_name) AS customer_name, COALESCE(c.phone, mo.guest_phone) AS customer_phone,
            s.name AS store_name, s.address AS store_address, s.phone AS store_phone
     FROM marketplace_orders mo JOIN stores s ON s.id = mo.store_id LEFT JOIN customers c ON c.id = mo.customer_id
     JOIN store_couriers sc ON sc.store_id = mo.store_id AND sc.partner_id = mo.courier_id AND sc.active
     WHERE mo.courier_id = $1 AND (mo.status IN ('confirmed','out_for_delivery') OR (mo.status = 'fulfilled' AND mo.fulfilled_at > now() - INTERVAL '7 days'))
     ORDER BY (mo.status = 'fulfilled'), mo.created_at`, [req.user.sub]
  );
  res.json(rows);
}

async function ownJob(req) {
  const { rows } = await db.query(
    `SELECT mo.* FROM marketplace_orders mo JOIN store_couriers sc ON sc.store_id = mo.store_id AND sc.partner_id = mo.courier_id AND sc.active
     WHERE mo.id = $1 AND mo.courier_id = $2`, [req.params.id, req.user.sub]
  );
  return rows[0];
}

// PATCH /api/partner/courier/jobs/:id/picked-up  — collected from the store
async function pickedUp(req, res) {
  const job = await ownJob(req);
  if (!job || !['confirmed', 'out_for_delivery'].includes(job.status)) return res.status(400).json({ error: 'Job not found or not ready' });
  await db.query(
    `UPDATE marketplace_orders SET status = 'out_for_delivery', courier_picked_at = now(), dispatched_at = COALESCE(dispatched_at, now()) WHERE id = $1`, [job.id]
  );
  emitToStore(job.store_id, 'marketplace:order_updated', { id: job.id, status: 'out_for_delivery' });
  res.json({ message: 'Marked as picked up' });
}

// PATCH /api/partner/courier/jobs/:id/delivered — runs the store's fulfil (stock out, cash recorded)
async function delivered(req, res) {
  const job = await ownJob(req);
  if (!job || job.status !== 'out_for_delivery') return res.status(400).json({ error: 'Mark the job as picked up first' });
  return require('./marketplaceController').fulfillOrder(
    { params: { storeId: job.store_id, orderId: job.id }, user: { sub: null } }, res
  );
}

module.exports = {
  createInvite, listCouriers, setCourierActive, assignCourier,
  getInvite, acceptInvite, partnerLogin,
  guarantorOverview, verifyMember, reportPayment,
  courierJobs, pickedUp, delivered,
};
