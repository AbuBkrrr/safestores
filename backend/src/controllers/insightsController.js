// ------------------------------------------------------------
// Insights: profit & margin, ABC analysis, dead stock, demand forecast,
// sales heatmap. Fetches raw rows; the maths lives in utils/insights.js
// (shared with the desktop edition).
// ------------------------------------------------------------
const db = require('../config/db');
const insights = require('../utils/insights');

function window(req) {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 730);
  const to = req.query.to ? new Date(`${req.query.to}T23:59:59.999Z`) : new Date();
  const from = req.query.from ? new Date(`${req.query.from}T00:00:00Z`) : new Date(to.getTime() - days * 86400000);
  return { from, to, days: Math.max(1, Math.round((to - from) / 86400000)) };
}

async function load(storeId, from, to) {
  const { rows: products } = await db.query(
    `SELECT id, name, sku, category, cost_price, price_multiplier, shelf_qty, backroom_qty, lead_time_days, created_at, archived_at
     FROM products WHERE store_id = $1`, [storeId]
  );
  const { rows: lines } = await db.query(
    `SELECT oi.product_id, oi.quantity, oi.line_total * (o.total / NULLIF(o.subtotal, 0)) AS line_total, o.paid_at
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.store_id = $1 AND o.status = 'paid' AND o.paid_at BETWEEN $2 AND $3`,
    [storeId, from, to]
  );
  const { rows: returns } = await db.query(
    `SELECT ri.product_id, ri.quantity, ri.amount FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id
     WHERE r.store_id = $1 AND r.created_at BETWEEN $2 AND $3`,
    [storeId, from, to]
  );
  // line_total above is scaled by total/subtotal so revenue reflects what
  // customers actually paid after order discounts.
  return { products, lines: lines.map((l) => ({ ...l, line_total: Number(l.line_total) || 0 })), returns };
}

async function profit(req, res) {
  const { from, to } = window(req);
  res.json({ from, to, ...insights.profit(await load(req.params.storeId, from, to)) });
}

async function abc(req, res) {
  const { from, to } = window(req);
  res.json({ from, to, ...insights.abc(await load(req.params.storeId, from, to)) });
}

async function deadStock(req, res) {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 60, 7), 730);
  const { storeId } = req.params;
  const { rows: products } = await db.query(
    'SELECT id, name, sku, cost_price, shelf_qty, backroom_qty, created_at, archived_at FROM products WHERE store_id = $1', [storeId]
  );
  const { rows: last } = await db.query(
    `SELECT product_id, MAX(created_at) AS last FROM stock_movements WHERE store_id = $1 AND type = 'sale' GROUP BY product_id`, [storeId]
  );
  res.json(insights.deadStock({ products, lastSold: new Map(last.map((l) => [l.product_id, l.last])), days }));
}

async function forecast(req, res) {
  const { from, to, days } = window(req);
  const data = await load(req.params.storeId, from, to);
  res.json(insights.forecast({ products: data.products, lines: data.lines, days }));
}

async function heatmap(req, res) {
  const { from, to } = window(req);
  const { storeId } = req.params;
  const { rows: st } = await db.query('SELECT timezone FROM stores WHERE id = $1', [storeId]);
  const { rows: orders } = await db.query(
    `SELECT paid_at, total FROM orders WHERE store_id = $1 AND status = 'paid' AND paid_at BETWEEN $2 AND $3`, [storeId, from, to]
  );
  res.json({ from, to, ...insights.heatmap({ orders, timeZone: st[0]?.timezone || 'UTC' }) });
}

module.exports = { profit, abc, deadStock, forecast, heatmap };
