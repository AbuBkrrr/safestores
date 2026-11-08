// ------------------------------------------------------------
// Daily Expiry & Batch Tracking sweep — desktop's local counterpart of
// what used to be a cloud job. Creates the in-app notification and fires
// a 'batch.expiring' webhook (see utils/webhooks.js) for any store that's
// subscribed one.
// ------------------------------------------------------------

const db = require('./db');
const { allocateFifoRemaining, daysUntil, suggestedDiscountPct, alertWindowDays } = require('./utils/batches');
const crypto = require('crypto');
const { dispatchEvent } = require('./utils/webhooks');

function runForStore(storeId) {
  const batchRows = db.prepare(
    `SELECT b.id, b.product_id, b.batch_number, b.expiry_date, b.quantity_received, p.name AS product_name, p.storage_type
     FROM batches b JOIN products p ON p.id = b.product_id
     WHERE b.store_id = ?`
  ).all(storeId);
  if (batchRows.length === 0) return;

  const consumedRows = db.prepare(
    `SELECT product_id, COALESCE(SUM(CASE WHEN type = 'return' THEN -quantity ELSE quantity END), 0) AS consumed
     FROM stock_movements WHERE store_id = ? AND type IN ('sale', 'damage', 'expiry', 'return')
     GROUP BY product_id`
  ).all(storeId);
  const consumedMap = new Map(consumedRows.map((r) => [r.product_id, Number(r.consumed)]));

  const byProduct = new Map();
  for (const b of batchRows) {
    if (!byProduct.has(b.product_id)) byProduct.set(b.product_id, []);
    byProduct.get(b.product_id).push({
      id: b.id, expiryDate: b.expiry_date, quantityReceived: b.quantity_received,
      batchNumber: b.batch_number, productName: b.product_name, storageType: b.storage_type,
    });
  }

  const expiring = [];
  for (const [productId, batches] of byProduct) {
    const withRemaining = allocateFifoRemaining(batches, consumedMap.get(productId) || 0);
    for (const b of withRemaining) {
      if (b.remaining <= 0) continue;
      const daysLeft = daysUntil(b.expiryDate);
      // Each batch checked against its OWN product's window — a frozen
      // item 12 days out is irrelevant right now (alertWindowDays caps at
      // 10 for frozen/refrigerated) even though an ambient item at the
      // same 12 days is squarely inside its 30-day window and worth
      // surfacing today.
      if (daysLeft <= alertWindowDays(b.storageType)) expiring.push({ ...b, daysUntilExpiry: daysLeft });
    }
  }
  if (expiring.length === 0) return;

  expiring.sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);
  const worst = expiring[0];
  const worstLabel = worst.daysUntilExpiry < 0
    ? `${worst.productName} already expired`
    : `${worst.productName} expires in ${worst.daysUntilExpiry} day${worst.daysUntilExpiry === 1 ? '' : 's'}`;

  // A single perishable (refrigerated/frozen) item inside its shorter
  // window is exactly as urgent as several ambient items piling up — flag
  // it as such rather than letting "only 1 batch" read as low-priority.
  const hasUrgentPerishable = expiring.some((b) => (b.storageType === 'refrigerated' || b.storageType === 'frozen') && b.daysUntilExpiry <= 2);
  const severity = hasUrgentPerishable || expiring.some((b) => b.daysUntilExpiry < 0) ? 'amber' : 'info';

  db.prepare(
    `INSERT INTO store_notifications (id, store_id, type, severity, audience_role, message)
     VALUES (?,?,?,?,'admin',?)`
  ).run(
    crypto.randomUUID(), storeId, 'expiry_alert', severity,
    `${expiring.length} batch${expiring.length > 1 ? 'es are' : ' is'} expiring soon — closest: ${worstLabel}${hasUrgentPerishable ? ' (refrigerated/frozen — act today)' : ''}. Check Expiry Tracker for markdown suggestions.`
  );

  dispatchEvent(storeId, 'batch.expiring', {
    count: expiring.length,
    batches: expiring.slice(0, 20).map((b) => ({
      productName: b.productName, batchNumber: b.batchNumber, expiryDate: b.expiryDate, storageType: b.storageType,
      remaining: b.remaining, daysUntilExpiry: b.daysUntilExpiry, suggestedDiscountPct: suggestedDiscountPct(b.daysUntilExpiry, b.storageType),
    })),
  });
}

function runExpirySweep() {
  try {
    const stores = db.prepare('SELECT id FROM stores').all();
    for (const store of stores) {
      try {
        runForStore(store.id);
      } catch (err) {
        console.error(`[expiry] failed for store ${store.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[expiry] sweep failed:', err.message);
  }
}

let lastRunDate = null;

/** Runs once a day, checked hourly. Returns a stop function. */
function startExpiryJob() {
  const check = () => {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== lastRunDate) {
      runExpirySweep();
      lastRunDate = today;
      console.log('[expiry] daily sweep completed');
    }
  };
  check();
  const handle = setInterval(check, 60 * 60 * 1000);
  return () => clearInterval(handle);
}

module.exports = { startExpiryJob, runExpirySweep };
