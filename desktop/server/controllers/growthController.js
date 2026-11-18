// ------------------------------------------------------------
// Desktop twin of the cloud's insightsController, stockToolsController
// (product import only — branch transfers are cloud-only, since a desktop
// install holds a single store) and loyaltyController.
// ------------------------------------------------------------
const crypto = require('crypto');
const db = require('../db');
const insights = require('../utils/insights');
const { normalizeRow } = require('../utils/productImport');
const { pointsEarned, balance, expiryDate } = require('../utils/loyalty');
const { r2 } = require('../utils/pricing');
const { recomputeProductQuantities } = require('../utils/stockMath');
const { findOrCreateSupplier } = require('../utils/supplierLookup');
const { logActivity } = require('../utils/activityLog');
const { emitToStore } = require('../realtime');

// ---------------- insights ----------------
function window(req) {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 730);
  const to = req.query.to ? new Date(`${req.query.to}T23:59:59.999Z`) : new Date();
  const from = req.query.from ? new Date(`${req.query.from}T00:00:00Z`) : new Date(to.getTime() - days * 86400000);
  return { from: from.toISOString(), to: to.toISOString(), days: Math.max(1, Math.round((to - from) / 86400000)) };
}

function load(storeId, from, to) {
  const products = db.prepare(
    'SELECT id, name, sku, category, cost_price, price_multiplier, shelf_qty, backroom_qty, lead_time_days, created_at, archived_at FROM products WHERE store_id = ?'
  ).all(storeId);
  const lines = db.prepare(
    `SELECT oi.product_id, oi.quantity, oi.line_total * (o.total / NULLIF(o.subtotal, 0)) AS line_total, o.paid_at
     FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.store_id = ? AND o.status = 'paid' AND o.paid_at BETWEEN ? AND ?`
  ).all(storeId, from, to).map((l) => ({ ...l, line_total: Number(l.line_total) || 0 }));
  const returns = db.prepare(
    `SELECT ri.product_id, ri.quantity, ri.amount FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id
     WHERE r.store_id = ? AND r.created_at BETWEEN ? AND ?`
  ).all(storeId, from, to);
  return { products, lines, returns };
}

function profit(req, res) { const w = window(req); res.json({ from: w.from, to: w.to, ...insights.profit(load(req.params.storeId, w.from, w.to)) }); }
function abc(req, res) { const w = window(req); res.json({ from: w.from, to: w.to, ...insights.abc(load(req.params.storeId, w.from, w.to)) }); }
function forecast(req, res) {
  const w = window(req);
  const d = load(req.params.storeId, w.from, w.to);
  res.json(insights.forecast({ products: d.products, lines: d.lines, days: w.days }));
}
function deadStock(req, res) {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 60, 7), 730);
  const { storeId } = req.params;
  const products = db.prepare('SELECT id, name, sku, cost_price, shelf_qty, backroom_qty, created_at, archived_at FROM products WHERE store_id = ?').all(storeId);
  const last = db.prepare(`SELECT product_id, MAX(created_at) AS last FROM stock_movements WHERE store_id = ? AND type = 'sale' GROUP BY product_id`).all(storeId);
  res.json(insights.deadStock({ products, lastSold: new Map(last.map((l) => [l.product_id, l.last])), days }));
}
function heatmap(req, res) {
  const w = window(req);
  const { storeId } = req.params;
  const tz = db.prepare('SELECT timezone FROM stores WHERE id = ?').get(storeId)?.timezone || 'UTC';
  const orders = db.prepare(`SELECT paid_at, total FROM orders WHERE store_id = ? AND status = 'paid' AND paid_at BETWEEN ? AND ?`).all(storeId, w.from, w.to);
  res.json({ from: w.from, to: w.to, ...insights.heatmap({ orders, timeZone: tz }) });
}

// ---------------- product import ----------------
function importProducts(req, res) {
  const { storeId } = req.params;
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rows || !rows.length) return res.status(400).json({ error: 'No rows to import' });
  if (rows.length > 5000) return res.status(400).json({ error: 'Import at most 5000 rows at a time' });
  const errors = []; const valid = []; const seen = new Set();
  rows.forEach((r, i) => {
    const n = normalizeRow(r);
    if (!n.ok) return errors.push({ row: i + 2, error: n.error });
    if (seen.has(n.value.sku.toLowerCase())) return errors.push({ row: i + 2, error: `Duplicate SKU in file: ${n.value.sku}` });
    seen.add(n.value.sku.toLowerCase());
    valid.push(n.value);
  });
  const bySku = new Map(db.prepare('SELECT id, sku FROM products WHERE store_id = ?').all(storeId).map((p) => [p.sku.toLowerCase(), p.id]));
  const toCreate = valid.filter((v) => !bySku.has(v.sku.toLowerCase()));
  const toUpdate = valid.filter((v) => bySku.has(v.sku.toLowerCase()));
  const max = db.prepare('SELECT t.max_products FROM stores s JOIN store_tiers t ON t.tier = s.store_tier WHERE s.id = ?').get(storeId)?.max_products;
  if (max != null && bySku.size + toCreate.length > max) {
    return res.status(403).json({ error: `This import would take you past your plan's ${max}-product limit (${bySku.size} now, ${toCreate.length} new).` });
  }
  if (req.body?.dryRun) return res.json({ dryRun: true, create: toCreate.length, update: toUpdate.length, errors });

  try {
    db.transaction(() => {
      for (const v of toCreate) {
        const id = crypto.randomUUID();
        db.prepare(
          `INSERT INTO products (id, store_id, name, sku, barcode, category, brand, supplier, supplier_id, unit, location, cost_price, price_multiplier, reorder_level, pack_size)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(id, storeId, v.name, v.sku, v.barcode, v.category, v.brand, v.supplier, v.supplier ? findOrCreateSupplier(db, storeId, v.supplier) : null,
          v.unit || 'unit', v.location, v.costPrice ?? 0, v.priceMultiplier ?? 1.3, v.reorderLevel ?? 5, v.packSize ?? 1);
        if (v.openingStock > 0) {
          db.prepare(`INSERT INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by) VALUES (?,?,?,'arrival',?,'Opening stock (import)',?)`)
            .run(crypto.randomUUID(), storeId, id, v.openingStock, req.user.sub);
          recomputeProductQuantities(db, id);
        }
      }
      for (const v of toUpdate) {
        const sets = ['name = ?']; const vals = [v.name];
        const add = (col, val) => { if (val !== null && val !== undefined) { sets.push(`${col} = ?`); vals.push(val); } };
        add('barcode', v.barcode); add('category', v.category); add('brand', v.brand); add('unit', v.unit); add('location', v.location);
        add('cost_price', v.costPrice); add('price_multiplier', v.priceMultiplier); add('reorder_level', v.reorderLevel); add('pack_size', v.packSize);
        if (v.supplier) { add('supplier', v.supplier); add('supplier_id', findOrCreateSupplier(db, storeId, v.supplier)); }
        db.prepare(`UPDATE products SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND store_id = ?`)
          .run(...vals, bySku.get(v.sku.toLowerCase()), storeId);
      }
    })();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Import failed — nothing was changed' });
  }
  logActivity(req, { storeId, action: 'product.imported', entityType: 'store', entityId: storeId, details: { created: toCreate.length, updated: toUpdate.length, skipped: errors.length } });
  emitToStore(storeId, 'product:bulk', {});
  res.json({ created: toCreate.length, updated: toUpdate.length, errors });
}

// ---------------- loyalty ----------------
function customerBalance(customerId) {
  return balance(db.prepare('SELECT points, created_at, expires_at FROM loyalty_points WHERE store_customer_id = ?').all(customerId));
}

/** Called inside payOrder's transaction once the order is paid. */
function settlePoints(order) {
  if (!order.store_customer_id) return;
  const st = db.prepare('SELECT points_per_100, points_expiry_months FROM stores WHERE id = ?').get(order.store_id) || {};
  if (order.points_redeemed > 0) {
    db.prepare(`INSERT INTO loyalty_points (id, store_id, store_customer_id, points, order_id, reason) VALUES (?,?,?,?,?,'redeemed')`)
      .run(crypto.randomUUID(), order.store_id, order.store_customer_id, -order.points_redeemed, order.id);
  }
  const earned = pointsEarned(order.total, st.points_per_100);
  if (earned > 0) {
    const exp = expiryDate(new Date(), st.points_expiry_months);
    db.prepare(`INSERT INTO loyalty_points (id, store_id, store_customer_id, points, order_id, reason, expires_at) VALUES (?,?,?,?,?,'sale',?)`)
      .run(crypto.randomUUID(), order.store_id, order.store_customer_id, earned, order.id, exp ? exp.toISOString() : null);
  }
}

function getPoints(req, res) {
  const { storeId, customerId } = req.params;
  if (!db.prepare('SELECT id FROM store_customers WHERE id = ? AND store_id = ?').get(customerId, storeId)) return res.status(404).json({ error: 'Customer not found' });
  const s = db.prepare('SELECT points_per_100, point_value, points_expiry_months FROM stores WHERE id = ?').get(storeId);
  const history = db.prepare('SELECT points, reason, order_id, expires_at, created_at FROM loyalty_points WHERE store_customer_id = ? ORDER BY created_at DESC LIMIT 200').all(customerId);
  const b = customerBalance(customerId);
  res.json({ ...b, value: r2(b.available * Number(s?.point_value || 0)), settings: s, history });
}

function redeemPoints(req, res) {
  const { storeId, orderId } = req.params;
  const { storeCustomerId } = req.body || {};
  const points = parseInt(req.body?.points, 10) || 0;
  const o = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ?').get(orderId, storeId);
  if (!o || o.status !== 'pending_payment') return res.status(400).json({ error: 'Order not found or no longer pending' });
  const s = db.prepare('SELECT point_value, points_per_100 FROM stores WHERE id = ?').get(storeId) || {};
  const value = Number(s.point_value || 0);
  if (!(Number(s.points_per_100) > 0) || value <= 0) return res.status(400).json({ error: 'Loyalty points are not turned on for this store' });
  if (!db.prepare('SELECT id FROM store_customers WHERE id = ? AND store_id = ? AND archived_at IS NULL').get(storeCustomerId, storeId)) return res.status(404).json({ error: 'Customer not found' });
  if (points < 0) return res.status(400).json({ error: 'Invalid points' });
  const b = customerBalance(storeCustomerId);
  if (points > b.available) return res.status(400).json({ error: `Only ${b.available} points available` });
  const use = Math.min(points, Math.floor(Number(o.subtotal) / value));
  const { recalcOrderTotals } = require('./ordersController');
  db.transaction(() => {
    db.prepare(
      `UPDATE orders SET store_customer_id = ?, points_redeemed = ?, discount_type = ?, discount_value = ?, discount_reason = ?, discount_approved_by = NULL WHERE id = ?`
    ).run(storeCustomerId, use, use > 0 ? 'amount' : null, r2(use * value), use > 0 ? 'Loyalty points' : null, orderId);
    recalcOrderTotals(orderId);
  })();
  logActivity(req, { storeId, action: 'order.points_redeemed', entityType: 'order', entityId: orderId, details: { points: use } });
  res.json(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
}

function attachCustomer(req, res) {
  const { storeId, orderId } = req.params;
  const id = req.body?.storeCustomerId || null;
  if (id && !db.prepare('SELECT id FROM store_customers WHERE id = ? AND store_id = ? AND archived_at IS NULL').get(id, storeId)) return res.status(404).json({ error: 'Customer not found' });
  const r = db.prepare(`UPDATE orders SET store_customer_id = ? WHERE id = ? AND store_id = ? AND status = 'pending_payment' AND points_redeemed = 0`).run(id, orderId, storeId);
  if (!r.changes) return res.status(400).json({ error: 'Order not found, already paid, or has points redeemed' });
  res.json(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
}

function upcomingBirthdays(req, res) {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 60);
  const rows = db.prepare('SELECT id, name, phone, email, birthday FROM store_customers WHERE store_id = ? AND archived_at IS NULL AND birthday IS NOT NULL').all(req.params.storeId);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const out = [];
  for (const c of rows) {
    const [, m, d] = String(c.birthday).slice(0, 10).split('-').map(Number);
    let next = new Date(today.getFullYear(), m - 1, d);
    if (next < today) next = new Date(today.getFullYear() + 1, m - 1, d);
    const inDays = Math.round((next - today) / 86400000);
    if (inDays <= days) out.push({ ...c, inDays });
  }
  res.json(out.sort((a, b) => a.inDays - b.inDays));
}

module.exports = {
  profit, abc, forecast, deadStock, heatmap, importProducts,
  settlePoints, getPoints, redeemPoints, attachCustomer, upcomingBirthdays,
};
