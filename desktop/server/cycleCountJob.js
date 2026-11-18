// ------------------------------------------------------------
// Daily Cycle Counting sweep — generates a small, ranked batch of new
// count tasks per store per day (never every product at once — see
// utils/cycleCounting.js), and flips any task whose due date has passed
// into 'overdue' so it surfaces distinctly in the frontend list rather
// than silently aging in the same 'pending' bucket forever.
// ------------------------------------------------------------

const db = require('./db');
const crypto = require('crypto');
const { riskTier, dueDateForTier } = require('./utils/cycleCounting');
const { dispatchEvent } = require('./utils/webhooks');

const MAX_NEW_TASKS_PER_STORE_PER_DAY = 5;
const DISCREPANCY_LOOKBACK_DAYS = 90;

function runForStore(storeId) {
  // Anything already pending/overdue doesn't need a new task generated
  // for the same product — one open task per product at a time.
  const openProductIds = new Set(
    db.prepare(
      `SELECT product_id FROM cycle_count_tasks WHERE store_id = ? AND status IN ('pending', 'overdue')`
    ).all(storeId).map((r) => r.product_id)
  );

  const products = db.prepare(
    `SELECT id, cost_price, shelf_qty, backroom_qty FROM products
     WHERE store_id = ? AND archived_at IS NULL`
  ).all(storeId);
  if (products.length === 0) return;

  const discrepancyRows = db.prepare(
    `SELECT product_id, COUNT(*) AS n FROM cycle_counts
     WHERE store_id = ? AND discrepancy != 0
       AND created_at >= datetime('now', '-${DISCREPANCY_LOOKBACK_DAYS} days')
     GROUP BY product_id`
  ).all(storeId);
  const discrepancyMap = new Map(discrepancyRows.map((r) => [r.product_id, r.n]));

  const lastCountRows = db.prepare(
    `SELECT product_id, MAX(created_at) AS last_at FROM cycle_counts WHERE store_id = ? GROUP BY product_id`
  ).all(storeId);
  const lastCountMap = new Map(lastCountRows.map((r) => [r.product_id, r.last_at]));

  const candidates = products
    .filter((p) => !openProductIds.has(p.id))
    .map((p) => {
      const valueAtStake = Number(p.cost_price || 0) * (Number(p.shelf_qty || 0) + Number(p.backroom_qty || 0));
      const lastAt = lastCountMap.get(p.id);
      const daysSinceLastCount = lastAt ? Math.floor((Date.now() - new Date(lastAt).getTime()) / 86400000) : null;
      const tier = riskTier(valueAtStake, discrepancyMap.get(p.id) || 0, daysSinceLastCount);
      return { productId: p.id, tier, valueAtStake, daysSinceLastCount };
    })
    // Never bother scheduling a count for something with zero value and no
    // history that was already checked recently — no signal says it needs one.
    .filter((c) => c.tier !== 'low' || c.daysSinceLastCount === null || c.daysSinceLastCount >= 60);

  const tierRank = { high: 0, medium: 1, low: 2 };
  candidates.sort((a, b) => tierRank[a.tier] - tierRank[b.tier] || b.valueAtStake - a.valueAtStake);

  const toCreate = candidates.slice(0, MAX_NEW_TASKS_PER_STORE_PER_DAY);
  const insert = db.prepare(
    `INSERT INTO cycle_count_tasks (id, store_id, product_id, risk_tier, due_date) VALUES (?,?,?,?,?)`
  );
  for (const c of toCreate) {
    insert.run(crypto.randomUUID(), storeId, c.productId, c.tier, dueDateForTier(c.tier));
  }

  const highPriority = toCreate.filter((c) => c.tier === 'high');
  if (highPriority.length > 0) {
    db.prepare(
      `INSERT INTO store_notifications (id, store_id, type, severity, audience_role, message)
       VALUES (?,?,?,?,'admin',?)`
    ).run(
      crypto.randomUUID(), storeId, 'cycle_count_task', 'amber',
      `${highPriority.length} high-priority cycle count${highPriority.length > 1 ? 's' : ''} scheduled — check Cycle Counting for today's list.`
    );

    const productNames = new Map(
      db.prepare(`SELECT id, name FROM products WHERE id IN (${highPriority.map(() => '?').join(',')})`)
        .all(...highPriority.map((c) => c.productId))
        .map((p) => [p.id, p.name])
    );
    dispatchEvent(storeId, 'cycle_count.high_priority', {
      count: highPriority.length,
      products: highPriority.map((c) => ({ productName: productNames.get(c.productId), valueAtStake: Math.round(c.valueAtStake * 100) / 100 })),
    });
  }
}

function markOverdueTasks() {
  db.prepare(
    `UPDATE cycle_count_tasks SET status = 'overdue' WHERE status = 'pending' AND due_date < date('now')`
  ).run();
}

function runCycleCountSweep() {
  try {
    markOverdueTasks();
    const stores = db.prepare('SELECT id FROM stores').all();
    for (const store of stores) {
      try {
        runForStore(store.id);
      } catch (err) {
        console.error(`[cycle-count] failed for store ${store.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[cycle-count] sweep failed:', err.message);
  }
}

let lastRunDate = null;

/** Runs once a day, checked hourly. Returns a stop function. */
function startCycleCountJob() {
  const check = () => {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== lastRunDate) {
      runCycleCountSweep();
      lastRunDate = today;
      console.log('[cycle-count] daily sweep completed');
    }
  };
  check();
  const handle = setInterval(check, 60 * 60 * 1000);
  return () => clearInterval(handle);
}

module.exports = { startCycleCountJob, runCycleCountSweep };
