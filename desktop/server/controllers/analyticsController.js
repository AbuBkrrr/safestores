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
function shrinkageReport(req, res) {
  const { storeId } = req.params;
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const shelfIncidents = db.prepare(
    `SELECT product_id, discrepancy FROM shelf_audits WHERE store_id = ? AND discrepancy < 0 AND created_at >= ?`
  ).all(storeId, since);
  const cycleIncidents = db.prepare(
    `SELECT product_id, discrepancy FROM cycle_counts WHERE store_id = ? AND discrepancy < 0 AND created_at >= ?`
  ).all(storeId, since);
  const incidents = [...shelfIncidents, ...cycleIncidents];

  const byProductId = new Map();
  for (const inc of incidents) {
    const entry = byProductId.get(inc.product_id) || { incidentCount: 0, unitsLost: 0 };
    entry.incidentCount += 1;
    entry.unitsLost += -inc.discrepancy;
    byProductId.set(inc.product_id, entry);
  }

  const byProduct = [];
  let totalValueLost = 0;
  let totalUnitsLost = 0;
  for (const [productId, entry] of byProductId) {
    const product = db.prepare('SELECT id, name, sku, cost_price FROM products WHERE id = ?').get(productId);
    if (!product) continue; // deleted since the incident — nothing left to attribute cost to
    const valueLost = entry.unitsLost * Number(product.cost_price);
    totalValueLost += valueLost;
    totalUnitsLost += entry.unitsLost;
    byProduct.push({
      product_id: productId, name: product.name, sku: product.sku,
      incident_count: entry.incidentCount, units_lost: entry.unitsLost, value_lost: valueLost,
    });
  }
  byProduct.sort((a, b) => b.value_lost - a.value_lost);

  res.json({ days, totalValueLost, totalUnitsLost, byProduct });
}

module.exports = { summary, stockByCategory, topProducts, movementTrends, lowStockDistribution, reorderAlerts, expiringSoon, shrinkageReport };
