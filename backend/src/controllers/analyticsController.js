// ------------------------------------------------------------
// Store analytics for the standalone web edition. Postgres-flavored twin
// of desktop/server/controllers/analyticsController.js — same queries,
// SQLite's datetime()/julianday()/strftime() swapped for Postgres's
// interval arithmetic and to_char(), SQLite's scalar max(x,y) swapped for
// Postgres's GREATEST().
// ------------------------------------------------------------

const db = require('../config/db');

async function summary(req, res) {
  const { storeId } = req.params;

  const { rows: productsRows } = await db.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM((backroom_qty + shelf_qty) * cost_price), 0) AS total_value
     FROM products WHERE store_id = $1`,
    [storeId]
  );
  const { rows: lowStockRows } = await db.query(
    `SELECT COUNT(*) AS count FROM products WHERE store_id = $1 AND shelf_qty <= reorder_level`,
    [storeId]
  );
  const { rows: pendingInvitesRows } = await db.query(
    `SELECT COUNT(*) AS count FROM invites WHERE store_id = $1 AND status = 'pending'`,
    [storeId]
  );

  res.json({
    totalProducts: Number(productsRows[0].count),
    totalStockValue: Number(productsRows[0].total_value),
    lowStockCount: Number(lowStockRows[0].count),
    pendingInvites: Number(pendingInvitesRows[0].count),
  });
}

async function stockByCategory(req, res) {
  const { storeId } = req.params;
  const { rows } = await db.query(
    `SELECT COALESCE(category, 'Uncategorized') AS category,
            SUM((backroom_qty + shelf_qty) * cost_price) AS value
     FROM products WHERE store_id = $1 GROUP BY category ORDER BY value DESC`,
    [storeId]
  );
  res.json(rows);
}

async function topProducts(req, res) {
  const { storeId } = req.params;
  const { rows } = await db.query(
    `SELECT name, ((backroom_qty + shelf_qty) * cost_price) AS value
     FROM products WHERE store_id = $1 ORDER BY value DESC LIMIT 10`,
    [storeId]
  );
  res.json(rows);
}

async function movementTrends(req, res) {
  const { storeId } = req.params;
  const days = Number(req.query.days) || 30;
  const { rows } = await db.query(
    `SELECT to_char(created_at, 'YYYY-MM-DD') AS day, type, SUM(ABS(quantity)) AS total
     FROM stock_movements
     WHERE store_id = $1 AND created_at >= now() - ($2 || ' days')::interval
     GROUP BY day, type ORDER BY day ASC`,
    [storeId, days]
  );
  res.json(rows.map((r) => ({ ...r, day: r.day + 'T00:00:00.000Z' })));
}

async function lowStockDistribution(req, res) {
  const { storeId } = req.params;
  const { rows } = await db.query(
    `SELECT COALESCE(category, 'Uncategorized') AS category, COUNT(*) AS count
     FROM products WHERE store_id = $1 AND shelf_qty <= reorder_level
     GROUP BY category ORDER BY count DESC`,
    [storeId]
  );
  res.json(rows);
}

// GET /api/stores/:storeId/analytics/reorder-alerts
// The Dashboard already shows a low-stock COUNT; this is the actionable
// list behind it — which specific products, how far under their reorder
// point, and a suggested reorder quantity (enough to get back to 2x the
// reorder level — a simple, transparent rule, not a demand-forecasting
// model).
async function reorderAlerts(req, res) {
  const { storeId } = req.params;
  const { rows } = await db.query(
    `SELECT id, name, sku, category, shelf_qty, backroom_qty, reorder_level,
            GREATEST(reorder_level * 2 - (shelf_qty + backroom_qty), 0) AS suggested_reorder_qty
     FROM products
     WHERE store_id = $1 AND (shelf_qty + backroom_qty) <= reorder_level
     ORDER BY (shelf_qty + backroom_qty) - reorder_level ASC`,
    [storeId]
  );
  res.json(rows);
}

// GET /api/stores/:storeId/analytics/expiring-soon?days=14
// Batch/expiry tracking using stock_arrivals.expiry_date — grouped per
// product so a near-expiry batch surfaces even if the product has plenty
// of OTHER, fresher stock too.
async function expiringSoon(req, res) {
  const { storeId } = req.params;
  const days = Math.max(1, Math.min(90, Number(req.query.days) || 14));
  const { rows } = await db.query(
    `SELECT sa.id AS arrival_id, sa.product_id, p.name, p.sku, sa.quantity, sa.expiry_date, sa.invoice_number,
            (sa.expiry_date::date - CURRENT_DATE) AS days_until_expiry
     FROM stock_arrivals sa
     JOIN products p ON p.id = sa.product_id
     WHERE sa.store_id = $1 AND sa.expiry_date IS NOT NULL
       AND sa.expiry_date::date <= (CURRENT_DATE + ($2 || ' days')::interval)
     ORDER BY sa.expiry_date ASC`,
    [storeId, days]
  );
  res.json(rows);
}

// GET /api/stores/:storeId/analytics/shrinkage?days=30
// Shrinkage = stock that's genuinely missing and unexplained — a
// negative discrepancy from a shelf audit or cycle count is the closest
// real signal for this, since it means someone physically counted LESS
// than the system's own movement history says should be there. A
// positive discrepancy (found MORE than expected) is excluded — that's
// a counting error to fix, not loss to report. Value is priced at cost,
// not sale price, since that's what the store actually lost.
async function shrinkageReport(req, res) {
  const { storeId } = req.params;
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));

  const { rows } = await db.query(
    `WITH incidents AS (
       SELECT sa.product_id, sa.discrepancy, sa.created_at, 'shelf_audit' AS source
       FROM shelf_audits sa WHERE sa.store_id = $1 AND sa.discrepancy < 0 AND sa.created_at >= now() - ($2 || ' days')::interval
       UNION ALL
       SELECT cc.product_id, cc.discrepancy, cc.created_at, 'cycle_count' AS source
       FROM cycle_counts cc WHERE cc.store_id = $1 AND cc.discrepancy < 0 AND cc.created_at >= now() - ($2 || ' days')::interval
     )
     SELECT p.id AS product_id, p.name, p.sku,
            COUNT(*) AS incident_count,
            SUM(-i.discrepancy) AS units_lost,
            SUM(-i.discrepancy * p.cost_price) AS value_lost
     FROM incidents i
     JOIN products p ON p.id = i.product_id
     GROUP BY p.id, p.name, p.sku
     ORDER BY value_lost DESC`,
    [storeId, days]
  );

  const totalValueLost = rows.reduce((sum, r) => sum + Number(r.value_lost), 0);
  const totalUnitsLost = rows.reduce((sum, r) => sum + Number(r.units_lost), 0);
  res.json({ days, totalValueLost, totalUnitsLost, byProduct: rows });
}

module.exports = { summary, stockByCategory, topProducts, movementTrends, lowStockDistribution, reorderAlerts, expiringSoon, shrinkageReport };
