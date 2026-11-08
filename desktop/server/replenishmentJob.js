// ------------------------------------------------------------
// Daily Smart Replenishment sweep — desktop/SQLite counterpart of
// backend/src/jobs/replenishmentJob.js. Same logic, single-store (a
// desktop install only ever has one store), synchronous better-sqlite3
// calls instead of async pg queries. Runs once a day, checked hourly so
// it survives the app not running at a fixed time — same approach as
// backupJob.js.
// ------------------------------------------------------------

const crypto = require('crypto');
const db = require('./db');
const { evaluateProduct, RECENT_WINDOW_DAYS } = require('./utils/replenishment');
const { findOrCreateSupplier } = require('./utils/supplierLookup');
const { dispatchEvent } = require('./utils/webhooks');

function fetchSalesWindows(storeId) {
  const rows = db.prepare(
    `SELECT product_id,
        COALESCE(SUM(CASE WHEN created_at >= datetime('now', ?) THEN quantity END), 0) AS recent_sold,
        COALESCE(SUM(CASE WHEN created_at < datetime('now', ?)
                            AND created_at >= datetime('now', ?) THEN quantity END), 0) AS prior_sold
     FROM stock_movements
     WHERE store_id = ? AND type = 'sale' AND created_at >= datetime('now', ?)
     GROUP BY product_id`
  ).all(
    `-${RECENT_WINDOW_DAYS} days`,
    `-${RECENT_WINDOW_DAYS} days`,
    `-${RECENT_WINDOW_DAYS * 2} days`,
    storeId,
    `-${RECENT_WINDOW_DAYS * 2} days`
  );
  const map = new Map();
  for (const r of rows) map.set(r.product_id, { recentSold: Number(r.recent_sold), priorSold: Number(r.prior_sold) });
  return map;
}

function runForStore(storeId) {
  const products = db.prepare(
    `SELECT id, name, supplier, cost_price, lead_time_days, min_order_qty, auto_reorder,
            (backroom_qty + shelf_qty) AS on_hand
     FROM products WHERE store_id = ?`
  ).all(storeId);
  if (products.length === 0) return;
  const salesWindows = fetchSalesWindows(storeId);

  const needsReorder = [];
  for (const p of products) {
    const { recentSold, priorSold } = salesWindows.get(p.id) || { recentSold: 0, priorSold: 0 };
    const evalResult = evaluateProduct({
      recentSold, priorSold, leadTimeDays: p.lead_time_days, onHand: Number(p.on_hand), minOrderQty: p.min_order_qty,
    });
    if (evalResult.needsReorder) needsReorder.push({ ...p, ...evalResult });
  }
  if (needsReorder.length === 0) return;

  const autoItems = needsReorder.filter((p) => p.auto_reorder);
  const manualItems = needsReorder.filter((p) => !p.auto_reorder);

  const bySupplier = new Map();
  for (const p of autoItems) {
    const key = p.supplier || 'Unspecified supplier';
    if (!bySupplier.has(key)) bySupplier.set(key, []);
    bySupplier.get(key).push(p);
  }

  for (const [supplier, items] of bySupplier) {
    const existingDraft = db.prepare(
      `SELECT id FROM purchase_orders WHERE store_id = ? AND supplier = ? AND status = 'draft' AND auto_generated = 1`
    ).get(storeId, supplier);
    if (existingDraft) continue; // an unreviewed auto-draft already covers this supplier

    try {
      db.transaction(() => {
        const totalCost = items.reduce((sum, p) => sum + p.suggestedQty * Number(p.cost_price), 0);
        const supplierId = findOrCreateSupplier(db, storeId, supplier);
        const poId = crypto.randomUUID();
        db.prepare(
          `INSERT INTO purchase_orders (id, store_id, supplier, supplier_id, status, auto_generated, total_cost)
           VALUES (?,?,?,?,'draft',1,?)`
        ).run(poId, storeId, supplier, supplierId, totalCost);
        for (const p of items) {
          db.prepare(
            `INSERT INTO purchase_order_items (id, purchase_order_id, product_id, quantity, unit_cost)
             VALUES (?,?,?,?,?)`
          ).run(crypto.randomUUID(), poId, p.id, p.suggestedQty, p.cost_price);
        }
        db.prepare(
          `INSERT INTO store_notifications (id, store_id, type, severity, audience_role, message)
           VALUES (?,?,?,?,'admin',?)`
        ).run(
          crypto.randomUUID(), storeId, 'po_auto_generated', 'amber',
          `Auto-generated a draft purchase order for ${supplier} (${items.length} item${items.length > 1 ? 's' : ''}) — review and send it.`
        );
      })();
      dispatchEvent(storeId, 'purchase_order.auto_created', { supplier, itemCount: items.length });
    } catch (err) {
      console.error(`[replenishment] failed auto-generating PO for ${supplier}:`, err.message);
    }
  }

  if (manualItems.length > 0) {
    db.prepare(
      `INSERT INTO store_notifications (id, store_id, type, severity, audience_role, message)
       VALUES (?,?,?,?,'admin',?)`
    ).run(
      crypto.randomUUID(), storeId, 'reorder_needed', 'amber',
      `${manualItems.length} product${manualItems.length > 1 ? 's are' : ' is'} at or below its reorder point. Check Replenishment suggestions.`
    );
  }
}

function runReplenishmentSweep() {
  try {
    const stores = db.prepare('SELECT id FROM stores').all();
    for (const store of stores) {
      try {
        runForStore(store.id);
      } catch (err) {
        console.error(`[replenishment] failed for store ${store.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[replenishment] sweep failed:', err.message);
  }
}

let lastRunDate = null;

/** Runs once a day, checked hourly. Returns a stop function. */
function startReplenishmentJob() {
  const check = () => {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== lastRunDate) {
      runReplenishmentSweep();
      lastRunDate = today;
      console.log('[replenishment] daily sweep completed');
    }
  };
  check(); // catch up immediately on launch, don't wait for the next hour mark
  const handle = setInterval(check, 60 * 60 * 1000);
  return () => clearInterval(handle);
}

module.exports = { startReplenishmentJob, runReplenishmentSweep };
