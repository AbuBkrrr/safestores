// ------------------------------------------------------------
// Cycle Counting & Inventory Accuracy.
//
// A cycle count validates a product's TOTAL on-hand quantity (shelf +
// backroom combined), unlike shelf_audits which is location-specific.
// Any discrepancy found is applied to the backroom pool specifically
// (via 'backroom_adjustment', not the plain 'adjustment' Shelf Audit
// uses for its shelf-specific corrections) and clamped so it can't drive
// backroom_qty negative — applying a combined-total discrepancy straight
// to shelf_qty used to be able to do exactly that whenever most of a
// product's real stock sat in the backroom (e.g. a -50 discrepancy
// against 11 on the shelf but 50 in the backroom left shelf_qty at -39).
// A discrepancy bigger than what's even recorded in the backroom gets
// flagged back to the caller instead of silently going negative.
// ------------------------------------------------------------

const crypto = require('crypto');
const db = require('../db');
const { recomputeProductQuantities } = require('../utils/stockMath');
const { emitToStore } = require('../realtime');

// GET /api/stores/:storeId/cycle-counts/tasks?status=pending
function listTasks(req, res) {
  const { storeId } = req.params;
  const { status } = req.query;
  const rows = status
    ? db.prepare(
        `SELECT t.*, p.name AS product_name, p.sku FROM cycle_count_tasks t
         JOIN products p ON p.id = t.product_id
         WHERE t.store_id = ? AND t.status = ? ORDER BY t.due_date ASC`
      ).all(storeId, status)
    : db.prepare(
        `SELECT t.*, p.name AS product_name, p.sku FROM cycle_count_tasks t
         JOIN products p ON p.id = t.product_id
         WHERE t.store_id = ? AND t.status IN ('pending', 'overdue') ORDER BY t.due_date ASC`
      ).all(storeId);
  res.json(rows);
}

// POST /api/stores/:storeId/cycle-counts/tasks/:id/skip
function skipTask(req, res) {
  const { storeId, id } = req.params;
  const result = db.prepare(
    `UPDATE cycle_count_tasks SET status = 'skipped' WHERE id = ? AND store_id = ? AND status IN ('pending','overdue')`
  ).run(id, storeId);
  if (result.changes === 0) return res.status(404).json({ error: 'Task not found or already resolved' });
  res.status(204).end();
}

// POST /api/stores/:storeId/cycle-counts   { id?, taskId?, productId, countedQty, autoAdjust }
function submitCount(req, res) {
  const { storeId } = req.params;
  const { id, taskId, productId, countedQty, autoAdjust, adjustmentMovementId } = req.body;
  if (!productId || countedQty === undefined) return res.status(400).json({ error: 'productId and countedQty are required' });

  if (id) {
    const existing = db.prepare('SELECT * FROM cycle_counts WHERE id = ?').get(id);
    if (existing) return res.status(201).json(existing); // already applied — safe no-op (offline retry)
  }

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND store_id = ?').get(productId, storeId);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const expected = Number(product.shelf_qty || 0) + Number(product.backroom_qty || 0);
  const discrepancy = countedQty - expected;
  const countId = id || crypto.randomUUID();
  let adjustmentWarning = null;

  db.transaction(() => {
    db.prepare(
      `INSERT INTO cycle_counts (id, store_id, product_id, task_id, counted_qty, expected_qty, discrepancy, auto_adjusted, performed_by)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(countId, storeId, productId, taskId || null, countedQty, expected, discrepancy, autoAdjust ? 1 : 0, req.user.sub);

    if (taskId) {
      db.prepare(
        `UPDATE cycle_count_tasks SET status = 'completed', cycle_count_id = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ? AND store_id = ?`
      ).run(countId, taskId, storeId);
    }

    if (autoAdjust && discrepancy !== 0) {
      const backroomQty = Number(product.backroom_qty || 0);
      const applied = Math.max(discrepancy, -backroomQty);
      if (applied !== 0) {
        db.prepare(
          `INSERT OR IGNORE INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by)
           VALUES (?,?,?,'backroom_adjustment',?,?,?)`
        ).run(adjustmentMovementId || crypto.randomUUID(), storeId, productId, applied, 'Auto-adjusted from cycle count', req.user.sub);
        recomputeProductQuantities(db, productId);
      }
      if (applied !== discrepancy) {
        adjustmentWarning = `Discrepancy of ${discrepancy} exceeds recorded backroom stock (${backroomQty}) — only ${applied} could be auto-adjusted. The remaining ${discrepancy - applied} may reflect shelf stock instead; consider a Shelf Audit too.`;
      }
    }
  })();

  const countRow = db.prepare(
    `SELECT cc.*, p.name AS product_name FROM cycle_counts cc JOIN products p ON p.id = cc.product_id WHERE cc.id = ?`
  ).get(countId);
  res.status(201).json({ ...countRow, warning: adjustmentWarning });
  try {
    emitToStore(storeId, 'cycle-count:created', countRow);
    if (autoAdjust && discrepancy !== 0) {
      emitToStore(storeId, 'product:updated', db.prepare('SELECT * FROM products WHERE id = ?').get(productId));
    }
  } catch (sideEffectErr) {
    console.error('submitCount: post-response realtime side effect failed:', sideEffectErr);
  }
}

// GET /api/stores/:storeId/cycle-counts/history?productId=
function listHistory(req, res) {
  const { storeId } = req.params;
  const { productId } = req.query;
  const rows = productId
    ? db.prepare(
        `SELECT cc.*, p.name AS product_name, u.name AS performed_by_name FROM cycle_counts cc
         JOIN products p ON p.id = cc.product_id LEFT JOIN users u ON u.id = cc.performed_by
         WHERE cc.store_id = ? AND cc.product_id = ? ORDER BY cc.created_at DESC LIMIT 100`
      ).all(storeId, productId)
    : db.prepare(
        `SELECT cc.*, p.name AS product_name, u.name AS performed_by_name FROM cycle_counts cc
         JOIN products p ON p.id = cc.product_id LEFT JOIN users u ON u.id = cc.performed_by
         WHERE cc.store_id = ? ORDER BY cc.created_at DESC LIMIT 100`
      ).all(storeId);
  res.json(rows);
}

// GET /api/stores/:storeId/cycle-counts/accuracy
// Store-wide accuracy stat: what fraction of counts in the last 90 days
// had zero discrepancy, plus the products with the worst track record.
function getAccuracy(req, res) {
  const { storeId } = req.params;
  const overall = db.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN discrepancy = 0 THEN 1 ELSE 0 END) AS accurate
     FROM cycle_counts WHERE store_id = ? AND created_at >= datetime('now', '-90 days')`
  ).get(storeId);

  const worstProducts = db.prepare(
    `SELECT p.name AS product_name, COUNT(*) AS count_events,
            SUM(CASE WHEN cc.discrepancy != 0 THEN 1 ELSE 0 END) AS discrepancy_events,
            AVG(ABS(cc.discrepancy)) AS avg_abs_discrepancy
     FROM cycle_counts cc JOIN products p ON p.id = cc.product_id
     WHERE cc.store_id = ? AND cc.created_at >= datetime('now', '-90 days')
     GROUP BY cc.product_id
     HAVING discrepancy_events > 0
     ORDER BY discrepancy_events DESC, avg_abs_discrepancy DESC
     LIMIT 10`
  ).all(storeId);

  res.json({
    totalCounts: Number(overall.total || 0),
    accurateCounts: Number(overall.accurate || 0),
    accuracyRate: overall.total > 0 ? Math.round((Number(overall.accurate) / Number(overall.total)) * 100) : null,
    worstProducts: worstProducts.map((p) => ({
      productName: p.product_name,
      countEvents: p.count_events,
      discrepancyEvents: p.discrepancy_events,
      avgAbsDiscrepancy: Math.round(Number(p.avg_abs_discrepancy) * 10) / 10,
    })),
  });
}

module.exports = { listTasks, skipTask, submitCount, listHistory, getAccuracy };
