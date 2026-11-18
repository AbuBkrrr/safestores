// ------------------------------------------------------------
// Loyalty points for in-store customers (POS). A store turns points on
// in Store Settings (points per 100 of spend, value of a point, expiry).
// Points are earned when a sale linked to a customer is paid, and can be
// redeemed at the till as a discount. Maths in utils/loyalty.js.
// ------------------------------------------------------------
const db = require('../config/db');
const { pointsEarned, balance, expiryDate } = require('../utils/loyalty');
const { r2 } = require('../utils/pricing');
const { logActivity } = require('../utils/activityLog');

async function customerBalance(client, customerId) {
  const { rows } = await client.query('SELECT points, created_at, expires_at FROM loyalty_points WHERE store_customer_id = $1', [customerId]);
  return balance(rows);
}

/** Called inside payOrder's transaction once the order is paid. */
async function settlePoints(client, order) {
  if (!order.store_customer_id) return;
  const { rows: s } = await client.query('SELECT points_per_100, points_expiry_months FROM stores WHERE id = $1', [order.store_id]);
  const st = s[0] || {};
  if (order.points_redeemed > 0) {
    await client.query(
      `INSERT INTO loyalty_points (store_id, store_customer_id, points, order_id, reason) VALUES ($1,$2,$3,$4,'redeemed')`,
      [order.store_id, order.store_customer_id, -order.points_redeemed, order.id]
    );
  }
  const earned = pointsEarned(order.total, st.points_per_100);
  if (earned > 0) {
    await client.query(
      `INSERT INTO loyalty_points (store_id, store_customer_id, points, order_id, reason, expires_at) VALUES ($1,$2,$3,$4,'sale',$5)`,
      [order.store_id, order.store_customer_id, earned, order.id, expiryDate(new Date(), st.points_expiry_months)]
    );
  }
}

// GET /customers/:customerId/points
async function getPoints(req, res) {
  const { storeId, customerId } = req.params;
  const { rows: c } = await db.query('SELECT id FROM store_customers WHERE id = $1 AND store_id = $2', [customerId, storeId]);
  if (!c[0]) return res.status(404).json({ error: 'Customer not found' });
  const { rows: s } = await db.query('SELECT points_per_100, point_value, points_expiry_months FROM stores WHERE id = $1', [storeId]);
  const { rows: history } = await db.query(
    'SELECT points, reason, order_id, expires_at, created_at FROM loyalty_points WHERE store_customer_id = $1 ORDER BY created_at DESC LIMIT 200', [customerId]
  );
  const b = await customerBalance(db, customerId);
  res.json({ ...b, value: r2(b.available * Number(s[0]?.point_value || 0)), settings: s[0], history });
}

// POST /orders/:orderId/redeem-points { storeCustomerId, points }
// Applies points as a fixed discount on a pending order (points × point value).
async function redeemPoints(req, res) {
  const { storeId, orderId } = req.params;
  const { storeCustomerId } = req.body || {};
  const points = parseInt(req.body?.points, 10) || 0;
  const { rows: o } = await db.query('SELECT * FROM orders WHERE id = $1 AND store_id = $2', [orderId, storeId]);
  if (!o[0] || o[0].status !== 'pending_payment') return res.status(400).json({ error: 'Order not found or no longer pending' });
  const { rows: s } = await db.query('SELECT point_value, points_per_100 FROM stores WHERE id = $1', [storeId]);
  const value = Number(s[0]?.point_value || 0);
  if (!(Number(s[0]?.points_per_100) > 0) || value <= 0) return res.status(400).json({ error: 'Loyalty points are not turned on for this store' });
  const { rows: c } = await db.query('SELECT id FROM store_customers WHERE id = $1 AND store_id = $2 AND archived_at IS NULL', [storeCustomerId, storeId]);
  if (!c[0]) return res.status(404).json({ error: 'Customer not found' });
  if (points < 0) return res.status(400).json({ error: 'Invalid points' });
  const b = await customerBalance(db, storeCustomerId);
  if (points > b.available) return res.status(400).json({ error: `Only ${b.available} points available` });
  const maxPoints = Math.floor(Number(o[0].subtotal) / value);
  const use = Math.min(points, maxPoints);

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE orders SET store_customer_id = $1, points_redeemed = $2,
         discount_type = CASE WHEN $2 > 0 THEN 'amount' ELSE NULL END, discount_value = $3,
         discount_reason = CASE WHEN $2 > 0 THEN 'Loyalty points' ELSE NULL END, discount_approved_by = NULL
       WHERE id = $4`,
      [storeCustomerId, use, r2(use * value), orderId]
    );
    const { recalcOrderTotals } = require('./ordersController');
    await recalcOrderTotals(client, orderId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Failed to redeem points' });
  } finally {
    client.release();
  }
  const { rows: fresh } = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  logActivity(req, { storeId, action: 'order.points_redeemed', entityType: 'order', entityId: orderId, details: { points: use } });
  res.json(fresh[0]);
}

// POST /orders/:orderId/customer { storeCustomerId|null } — attach a customer to a sale (earns points, shows on receipt).
async function attachCustomer(req, res) {
  const { storeId, orderId } = req.params;
  const id = req.body?.storeCustomerId || null;
  if (id) {
    const { rows: c } = await db.query('SELECT id FROM store_customers WHERE id = $1 AND store_id = $2 AND archived_at IS NULL', [id, storeId]);
    if (!c[0]) return res.status(404).json({ error: 'Customer not found' });
  }
  const { rows } = await db.query(
    `UPDATE orders SET store_customer_id = $1 WHERE id = $2 AND store_id = $3 AND status = 'pending_payment' AND points_redeemed = 0 RETURNING *`,
    [id, orderId, storeId]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Order not found, already paid, or has points redeemed' });
  res.json(rows[0]);
}

// GET /customers/birthdays?days=7 — birthdays in the next N days (year ignored).
async function upcomingBirthdays(req, res) {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 60);
  const { rows } = await db.query(
    `SELECT id, name, phone, email, birthday FROM store_customers
     WHERE store_id = $1 AND archived_at IS NULL AND birthday IS NOT NULL`, [req.params.storeId]
  );
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const out = [];
  for (const c of rows) {
    const b = new Date(c.birthday);
    let next = new Date(today.getFullYear(), b.getUTCMonth(), b.getUTCDate());
    if (next < today) next = new Date(today.getFullYear() + 1, b.getUTCMonth(), b.getUTCDate());
    const inDays = Math.round((next - today) / 86400000);
    if (inDays <= days) out.push({ ...c, inDays });
  }
  res.json(out.sort((a, b) => a.inDays - b.inDays));
}

module.exports = { settlePoints, getPoints, redeemPoints, attachCustomer, upcomingBirthdays, customerBalance };
