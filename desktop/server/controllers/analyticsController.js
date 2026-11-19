const db = require('../db');

function summary(req, res) {
  const { storeId } = req.params;

  const products = db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM((backroom_qty + shelf_qty) * cost_price), 0) AS total_value
     FROM products WHERE store_id = ?`
  ).get(storeId);

  const lowStock = db.prepare(
    `SELECT COUNT(*) AS count FROM products WHERE store_id = ? AND shelf_qty <= reorder_level`
  ).get(storeId);

  const pendingInvites = db.prepare(
    `SELECT COUNT(*) AS count FROM invites WHERE store_id = ? AND status = 'pending'`
  ).get(storeId);

  res.json({
    totalProducts: products.count,
    totalStockValue: products.total_value,
    lowStockCount: lowStock.count,
    pendingInvites: pendingInvites.count,
  });
}

function stockByCategory(req, res) {
  const { storeId } = req.params;
  const rows = db.prepare(
    `SELECT COALESCE(category, 'Uncategorized') AS category,
            SUM((backroom_qty + shelf_qty) * cost_price) AS value
     FROM products WHERE store_id = ? GROUP BY category ORDER BY value DESC`
  ).all(storeId);
  res.json(rows);
}

function topProducts(req, res) {
  const { storeId } = req.params;
  const rows = db.prepare(
    `SELECT name, ((backroom_qty + shelf_qty) * cost_price) AS value
     FROM products WHERE store_id = ? ORDER BY value DESC LIMIT 10`
  ).all(storeId);
  res.json(rows);
}

function movementTrends(req, res) {
  const { storeId } = req.params;
  const days = Number(req.query.days) || 30;
  const rows = db.prepare(
    `SELECT strftime('%Y-%m-%d', created_at) AS day, type, SUM(ABS(quantity)) AS total
     FROM stock_movements
     WHERE store_id = ? AND created_at >= datetime('now', '-' || ? || ' days')
     GROUP BY day, type ORDER BY day ASC`
  ).all(storeId, days);
  res.json(rows.map((r) => ({ ...r, day: r.day + 'T00:00:00.000Z' })));
}

function lowStockDistribution(req, res) {
  const { storeId } = req.params;
  const rows = db.prepare(
    `SELECT COALESCE(category, 'Uncategorized') AS category, COUNT(*) AS count
     FROM products WHERE store_id = ? AND shelf_qty <= reorder_level
     GROUP BY category ORDER BY count DESC`
  ).all(storeId);
  res.json(rows);
}

// GET /stores/:storeId/analytics/reorder-alerts
// The Dashboard already shows a low-stock COUNT; this is the actionable
// list behind it — which specific products, how far under their reorder
// point, and a suggested reorder quantity (enough to get back to 2x the
// reorder level — a simple, transparent rule, not a demand-forecasting
// model; see the recommendations note on seasonal/velocity-based
// forecasting for what a fuller version of this would need).
function reorderAlerts(req, res) {
  const { storeId } = req.params;
  const rows = db.prepare(
    `SELECT id, name, sku, category, shelf_qty, backroom_qty, reorder_level,
            MAX(reorder_level * 2 - (shelf_qty + backroom_qty), 0) AS suggested_reorder_qty
     FROM products
     WHERE store_id = ? AND (shelf_qty + backroom_qty) <= reorder_level
     ORDER BY (shelf_qty + backroom_qty) - reorder_level ASC`
  ).all(storeId);
  res.json(rows);
}

// GET /stores/:storeId/analytics/expiring-soon?days=14
// Batch/expiry tracking using stock_arrivals.expiry_date, which already
// existed but had nothing querying it — grouped per product so a near-
// expiry batch surfaces even if the product has plenty of OTHER,
// fresher stock too.
function expiringSoon(req, res) {
  const { storeId } = req.params;
  const days = Math.max(1, Math.min(90, Number(req.query.days) || 14));
  const rows = db.prepare(
    `SELECT sa.id AS arrival_id, sa.product_id, p.name, p.sku, sa.quantity, sa.expiry_date, sa.invoice_number,
            CAST(julianday(sa.expiry_date) - julianday('now') AS INTEGER) AS days_until_expiry
     FROM stock_arrivals sa
     JOIN products p ON p.id = sa.product_id
     WHERE sa.store_id = ? AND sa.expiry_date IS NOT NULL
       AND date(sa.expiry_date) <= date('now', '+' || ? || ' days')
     ORDER BY sa.expiry_date ASC`
  ).all(storeId, days);
  res.json(rows);
}

// GET /api/stores/:storeId/analytics/shrinkage?days=30
// See backend/src/controllers/analyticsController.js's shrinkageReport
// for the full rationale (shrinkage = negative discrepancies from a
// shelf audit or cycle count, priced at cost). Aggregated in JS rather
// than SQL UNION/GROUP BY — same reasoning as suppliersController.js's
// header: this file's other functions already follow that pattern.
// The store's own record of stock that went missing or bad: short counts,
// damaged/spoiled write-offs and handovers that arrived short. Booked
// auditors' shelf counts are deliberately left out (their findings go to
// SAFE Stores, not the shop). Same as the cloud edition.
function shrinkageReport(req, res) {
  const { storeId } = req.params;
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const incidents = [
    ...db.prepare(`SELECT product_id, -discrepancy AS qty, 'count' AS source FROM cycle_counts WHERE store_id = ? AND discrepancy < 0 AND created_at >= ?`).all(storeId, since),
    ...db.prepare(
      `SELECT product_id, quantity AS qty, CASE WHEN type = 'expiry' THEN 'spoiled' ELSE 'damaged' END AS source
       FROM stock_movements WHERE store_id = ? AND type IN ('damage', 'expiry', 'return_damaged') AND created_at >= ?`
    ).all(storeId, since),
    ...db.prepare(
      `SELECT hi.product_id, hi.qty_issued - hi.qty_received AS qty, 'handover_short' AS source
       FROM stock_handover_items hi JOIN stock_handovers h ON h.id = hi.handover_id
       WHERE h.store_id = ? AND h.status = 'short' AND hi.qty_received < hi.qty_issued AND h.received_at >= ?`
    ).all(storeId, since),
  ];

  const products = new Map();
  const productOf = (id) => {
    if (!products.has(id)) products.set(id, db.prepare('SELECT id, name, sku, unit, sold_by, cost_price FROM products WHERE id = ?').get(id) || null);
    return products.get(id);
  };
  const byProductId = new Map();
  const bySourceMap = new Map();
  for (const inc of incidents) {
    const p = productOf(inc.product_id);
    if (!p) continue; // deleted since — nothing left to attribute cost to
    const value = Number(inc.qty) * Number(p.cost_price);
    const e = byProductId.get(p.id) || { product_id: p.id, name: p.name, sku: p.sku, unit: p.unit, sold_by: p.sold_by, incident_count: 0, units_lost: 0, value_lost: 0 };
    e.incident_count += 1; e.units_lost += Number(inc.qty); e.value_lost += value;
    byProductId.set(p.id, e);
    const src = bySourceMap.get(inc.source) || { source: inc.source, incidents: 0, value_lost: 0 };
    src.incidents += 1; src.value_lost += value;
    bySourceMap.set(inc.source, src);
  }
  const round = (n) => Math.round(n * 1000) / 1000;
  const byProduct = [...byProductId.values()].map((e) => ({ ...e, units_lost: round(e.units_lost), value_lost: Math.round(e.value_lost * 100) / 100 }))
    .sort((a, b) => b.value_lost - a.value_lost);
  res.json({
    days,
    totalValueLost: Math.round(byProduct.reduce((s, r) => s + r.value_lost, 0) * 100) / 100,
    totalUnitsLost: round(byProduct.reduce((s, r) => s + r.units_lost, 0)),
    byProduct,
    bySource: [...bySourceMap.values()].map((r) => ({ ...r, value_lost: Math.round(r.value_lost * 100) / 100 })).sort((a, b) => b.value_lost - a.value_lost),
  });
}

module.exports = { summary, stockByCategory, topProducts, movementTrends, lowStockDistribution, reorderAlerts, expiringSoon, shrinkageReport };
