// ------------------------------------------------------------
// Daily Cycle Counting sweep for the standalone web edition. Postgres
// twin of desktop/server/cycleCountJob.js — same risk-ranking logic
// (utils/cycleCounting.js is pure JS, unchanged), same "small batch per
// store per day" philosophy. Exposes the same dual shape as
// billingJob.js: startCycleCountJob() for server.js's always-on process,
// runCycleCountSweep() for netlify/functions/cycle-count-cron.js's
// serverless schedule — see that job's header for why both exist.
// ------------------------------------------------------------

const crypto = require('crypto');
const db = require('../config/db');
const { emitToStore } = require('../realtime');
const { dispatchEvent } = require('../utils/webhooks');
const { riskTier, dueDateForTier } = require('../utils/cycleCounting');
const { captureException } = require('../utils/errorMonitoring');

const MAX_NEW_TASKS_PER_STORE_PER_DAY = 5;
const DISCREPANCY_LOOKBACK_DAYS = 90;

async function runForStore(storeId) {
  const { rows: openRows } = await db.query(
    `SELECT product_id FROM cycle_count_tasks WHERE store_id = $1 AND status IN ('pending', 'overdue')`,
    [storeId]
  );
  const openProductIds = new Set(openRows.map((r) => r.product_id));

  const { rows: products } = await db.query(
    `SELECT id, cost_price, shelf_qty, backroom_qty FROM products WHERE store_id = $1 AND archived_at IS NULL`,
    [storeId]
  );
  if (products.length === 0) return;

  const { rows: discrepancyRows } = await db.query(
    `SELECT product_id, COUNT(*) AS n FROM cycle_counts
     WHERE store_id = $1 AND discrepancy != 0 AND created_at >= now() - interval '${DISCREPANCY_LOOKBACK_DAYS} days'
     GROUP BY product_id`,
    [storeId]
  );
  const discrepancyMap = new Map(discrepancyRows.map((r) => [r.product_id, Number(r.n)]));

  const { rows: lastCountRows } = await db.query(
    `SELECT product_id, MAX(created_at) AS last_at FROM cycle_counts WHERE store_id = $1 GROUP BY product_id`,
    [storeId]
  );
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
    .filter((c) => c.tier !== 'low' || c.daysSinceLastCount === null || c.daysSinceLastCount >= 60);

  const tierRank = { high: 0, medium: 1, low: 2 };
  candidates.sort((a, b) => tierRank[a.tier] - tierRank[b.tier] || b.valueAtStake - a.valueAtStake);

  const toCreate = candidates.slice(0, MAX_NEW_TASKS_PER_STORE_PER_DAY);
  for (const c of toCreate) {
    await db.query(
      `INSERT INTO cycle_count_tasks (id, store_id, product_id, risk_tier, due_date) VALUES ($1,$2,$3,$4,$5)`,
      [crypto.randomUUID(), storeId, c.productId, c.tier, dueDateForTier(c.tier)]
    );
  }

  const highPriority = toCreate.filter((c) => c.tier === 'high');
  if (highPriority.length > 0) {
    await db.query(
      `INSERT INTO store_notifications (id, store_id, type, severity, audience_role, message)
       VALUES ($1,$2,$3,'amber','admin',$4)`,
      [crypto.randomUUID(), storeId, 'cycle_count_task',
        `${highPriority.length} high-priority cycle count${highPriority.length > 1 ? 's' : ''} scheduled — check Cycle Counting for today's list.`]
    );
    emitToStore(storeId, 'notification:new', { type: 'cycle_count_task' });

    const { rows: productNameRows } = await db.query(
      `SELECT id, name FROM products WHERE id = ANY($1::uuid[])`,
      [highPriority.map((c) => c.productId)]
    );
    const productNames = new Map(productNameRows.map((p) => [p.id, p.name]));
    dispatchEvent(storeId, 'cycle_count.high_priority', {
      count: highPriority.length,
      products: highPriority.map((c) => ({ productName: productNames.get(c.productId), valueAtStake: Math.round(c.valueAtStake * 100) / 100 })),
    });
  }
}

async function markOverdueTasks() {
  await db.query(`UPDATE cycle_count_tasks SET status = 'overdue' WHERE status = 'pending' AND due_date < CURRENT_DATE`);
}

async function runCycleCountSweep() {
  try {
    await markOverdueTasks();
    const { rows: stores } = await db.query('SELECT id FROM stores');
    for (const store of stores) {
      try {
        await runForStore(store.id);
      } catch (err) {
        console.error(`[cycle-count] failed for store ${store.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[cycle-count] sweep failed:', err.message);
    captureException(err, { job: 'cycle-count' });
  }
}

let lastRunDate = null;

/** Starts the periodic sweep for server.js's always-on process. Returns a stop function. */
function startCycleCountJob(intervalMs = 60 * 60 * 1000) {
  const check = () => {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== lastRunDate) {
      runCycleCountSweep();
      lastRunDate = today;
    }
  };
  check();
  const interval = setInterval(check, intervalMs);
  return () => clearInterval(interval);
}

module.exports = { startCycleCountJob, runCycleCountSweep };
