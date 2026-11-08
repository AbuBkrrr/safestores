// ------------------------------------------------------------
// Cycle Counting & Inventory Accuracy for the standalone web edition.
// Postgres-flavored twin of desktop/server/controllers/cycleCountController.js
// — same rationale (see that file's header), same risk-scoring logic
// (utils/cycleCounting.js is pure JS, copied over unchanged), just async
// db.query instead of better-sqlite3's synchronous API.
// ------------------------------------------------------------

const crypto = require('crypto');
const db = require('../config/db');
const { emitToStore } = require('../realtime');
const { recomputeProductQuantities } = require('../utils/stockMath');

// GET /api/stores/:storeId/cycle-counts/tasks?status=pending
async function listTasks(req, res) {
  const { storeId } = req.params;
  const { status } = req.query;
  const { rows } = status
    ? await db.query(
        `SELECT t.*, p.name AS product_name, p.sku FROM cycle_count_tasks t
         JOIN products p ON p.id = t.product_id
         WHERE t.store_id = $1 AND t.status = $2 ORDER BY t.due_date ASC`,
        [storeId, status]
      )
    : await db.query(
        `SELECT t.*, p.name AS product_name, p.sku FROM cycle_count_tasks t
         JOIN products p ON p.id = t.product_id
         WHERE t.store_id = $1 AND t.status IN ('pending', 'overdue') ORDER BY t.due_date ASC`,
        [storeId]
      );
  res.json(rows);
}

// POST /api/stores/:storeId/cycle-counts/tasks/:id/skip
async function skipTask(req, res) {
  const { storeId, id } = req.params;
  const { rowCount } = await db.query(
    `UPDATE cycle_count_tasks SET status = 'skipped' WHERE id = $1 AND store_id = $2 AND status IN ('pending','overdue')`,
    [id, storeId]
  );
  if (!rowCount) return res.status(404).json({ error: 'Task not found or already resolved' });
  res.status(204).end();
}

// POST /api/stores/:storeId/cycle-counts   { id?, taskId?, productId, countedQty, autoAdjust }
async function submitCount(req, res) {
  const { storeId } = req.params;
  const { id, taskId, productId, countedQty, autoAdjust } = req.body;
  if (!productId || countedQty === undefined) return res.status(400).json({ error: 'productId and countedQty are required' });

  if (id) {
    const { rows: existingRows } = await db.query('SELECT * FROM cycle_counts WHERE id = $1', [id]);
    if (existingRows[0]) return res.status(201).json(existingRows[0]); // already applied — safe no-op (offline retry)
  }

  const { rows: productRows } = await db.query('SELECT * FROM products WHERE id = $1 AND store_id = $2', [productId, storeId]);
  const product = productRows[0];
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const expected = Number(product.shelf_qty || 0) + Number(product.backroom_qty || 0);
  const discrepancy = countedQty - expected;
  const countId = id || crypto.randomUUID();

  const client = await db.pool.connect();
  let productAfterAdjust = null;
  let adjustmentWarning = null;
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO cycle_counts (id, store_id, product_id, task_id, counted_qty, expected_qty, discrepancy, auto_adjusted, performed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [countId, storeId, productId, taskId || null, countedQty, expected, discrepancy, !!autoAdjust, req.user.sub]
    );

    if (taskId) {
      await client.query(
        `UPDATE cycle_count_tasks SET status = 'completed', cycle_count_id = $1, completed_at = now()
         WHERE id = $2 AND store_id = $3`,
        [countId, taskId, storeId]
      );
    }

    if (autoAdjust && discrepancy !== 0) {
      // Cycle counts compare against the combined backroom+shelf total,
      // not either pool individually (contrast with Shelf Audit, which
      // always knows exactly which single pool it counted and adjusts
      // that one specifically — see its own two-movement-type branch).
      // Applying a combined-total discrepancy straight to shelf_qty (the
      // 'adjustment' movement type) could drive it negative whenever
      // most of a product's real stock sits in the backroom — a -50
      // discrepancy against 11 on the shelf but 50 in the backroom used
      // to leave shelf_qty at -39. Backroom is the intended target here
      // (it's the bulk, less continuously-verified pool; the shelf count
      // is what Shelf Audit exists to keep precise), and clamped so it
      // can't go negative either — a discrepancy bigger than what's even
      // recorded in the backroom is flagged back to the caller instead
      // of silently producing a nonsensical negative stock figure.
      const backroomQty = Number(product.backroom_qty || 0);
      const applied = Math.max(discrepancy, -backroomQty);
      if (applied !== 0) {
        await client.query(
          `INSERT INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by)
           VALUES ($1,$2,$3,'backroom_adjustment',$4,$5,$6)`,
          [crypto.randomUUID(), storeId, productId, applied, 'Auto-adjusted from cycle count', req.user.sub]
        );
        productAfterAdjust = await recomputeProductQuantities(client, productId);
      }
      if (applied !== discrepancy) {
        adjustmentWarning = `Discrepancy of ${discrepancy} exceeds recorded backroom stock (${backroomQty}) — only ${applied} could be auto-adjusted. The remaining ${discrepancy - applied} may reflect shelf stock instead; consider a Shelf Audit too.`;
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    // submitCount is registered directly as the route handler (no
    // wrapping asyncHandler — this app is on Express 4, which does not
    // auto-catch a rejected promise from an async middleware the way
    // Express 5 does). Rethrowing here without responding would leave
    // the request hanging forever on any transaction failure, since
    // nothing downstream would ever call res.json()/res.status().
    console.error(err);
    return res.status(500).json({ error: 'Failed to record cycle count' });
  } finally {
    client.release();
  }

  const { rows: countRows } = await db.query(
    `SELECT cc.*, p.name AS product_name FROM cycle_counts cc JOIN products p ON p.id = cc.product_id WHERE cc.id = $1`,
    [countId]
  );
  res.status(201).json({ ...countRows[0], warning: adjustmentWarning });
  try {
    emitToStore(storeId, 'cycle-count:created', countRows[0]);
    if (productAfterAdjust) {
      emitToStore(storeId, 'product:updated', productAfterAdjust);
    }
  } catch (sideEffectErr) {
    console.error('submitCount: post-response realtime side effect failed:', sideEffectErr);
  }
}

// GET /api/stores/:storeId/cycle-counts/history?productId=
async function listHistory(req, res) {
  const { storeId } = req.params;
  const { productId } = req.query;
  const { rows } = productId
    ? await db.query(
        `SELECT cc.*, p.name AS product_name, u.name AS performed_by_name FROM cycle_counts cc
         JOIN products p ON p.id = cc.product_id LEFT JOIN users u ON u.id = cc.performed_by
         WHERE cc.store_id = $1 AND cc.product_id = $2 ORDER BY cc.created_at DESC LIMIT 100`,
        [storeId, productId]
      )
    : await db.query(
        `SELECT cc.*, p.name AS product_name, u.name AS performed_by_name FROM cycle_counts cc
         JOIN products p ON p.id = cc.product_id LEFT JOIN users u ON u.id = cc.performed_by
         WHERE cc.store_id = $1 ORDER BY cc.created_at DESC LIMIT 100`,
        [storeId]
      );
  res.json(rows);
}

// GET /api/stores/:storeId/cycle-counts/accuracy
async function getAccuracy(req, res) {
  const { storeId } = req.params;
  const { rows: overallRows } = await db.query(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN discrepancy = 0 THEN 1 ELSE 0 END) AS accurate
     FROM cycle_counts WHERE store_id = $1 AND created_at >= now() - interval '90 days'`,
    [storeId]
  );
  const overall = overallRows[0];

  const { rows: worstProducts } = await db.query(
    `SELECT p.name AS product_name, COUNT(*) AS count_events,
            SUM(CASE WHEN cc.discrepancy != 0 THEN 1 ELSE 0 END) AS discrepancy_events,
            AVG(ABS(cc.discrepancy)) AS avg_abs_discrepancy
     FROM cycle_counts cc JOIN products p ON p.id = cc.product_id
     WHERE cc.store_id = $1 AND cc.created_at >= now() - interval '90 days'
     GROUP BY cc.product_id, p.name
     HAVING SUM(CASE WHEN cc.discrepancy != 0 THEN 1 ELSE 0 END) > 0
     ORDER BY discrepancy_events DESC, avg_abs_discrepancy DESC
     LIMIT 10`,
    [storeId]
  );

  res.json({
    totalCounts: Number(overall.total || 0),
    accurateCounts: Number(overall.accurate || 0),
    accuracyRate: overall.total > 0 ? Math.round((Number(overall.accurate) / Number(overall.total)) * 100) : null,
    worstProducts: worstProducts.map((p) => ({
      productName: p.product_name,
      countEvents: Number(p.count_events),
      discrepancyEvents: Number(p.discrepancy_events),
      avgAbsDiscrepancy: Math.round(Number(p.avg_abs_discrepancy) * 10) / 10,
    })),
  });
}

module.exports = { listTasks, skipTask, submitCount, listHistory, getAccuracy };
