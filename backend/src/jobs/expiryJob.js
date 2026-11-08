// ------------------------------------------------------------
// Daily Expiry & Batch Tracking alert sweep for the standalone web
// edition. Postgres twin of desktop/server/expiryJob.js — same FIFO
// remaining-quantity + storage-type-aware urgency logic (utils/batches.js
// is pure JS, unchanged), same dual server/serverless shape as
// billingJob.js (startExpiryJob for server.js's always-on process,
// runExpirySweep for netlify/functions/expiry-cron.js's schedule).
// ------------------------------------------------------------

const crypto = require('crypto');
const db = require('../config/db');
const { allocateFifoRemaining, daysUntil, suggestedDiscountPct, alertWindowDays } = require('../utils/batches');
const { dispatchEvent } = require('../utils/webhooks');
const { emitToStore } = require('../realtime');
const { captureException } = require('../utils/errorMonitoring');

async function runForStore(storeId) {
  const { rows: batchRows } = await db.query(
    `SELECT b.id, b.product_id, b.batch_number, b.expiry_date, b.quantity_received, p.name AS product_name, p.storage_type
     FROM batches b JOIN products p ON p.id = b.product_id
     WHERE b.store_id = $1`,
    [storeId]
  );
  if (batchRows.length === 0) return;

  const { rows: consumedRows } = await db.query(
    `SELECT product_id, COALESCE(SUM(quantity), 0) AS consumed
     FROM stock_movements WHERE store_id = $1 AND type IN ('sale', 'damage', 'expiry')
     GROUP BY product_id`,
    [storeId]
  );
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
      if (daysLeft <= alertWindowDays(b.storageType)) expiring.push({ ...b, daysUntilExpiry: daysLeft });
    }
  }
  if (expiring.length === 0) return;

  expiring.sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);
  const worst = expiring[0];
  const worstLabel = worst.daysUntilExpiry < 0
    ? `${worst.productName} already expired`
    : `${worst.productName} expires in ${worst.daysUntilExpiry} day${worst.daysUntilExpiry === 1 ? '' : 's'}`;

  const hasUrgentPerishable = expiring.some((b) => (b.storageType === 'refrigerated' || b.storageType === 'frozen') && b.daysUntilExpiry <= 2);
  const severity = hasUrgentPerishable || expiring.some((b) => b.daysUntilExpiry < 0) ? 'amber' : 'info';

  await db.query(
    `INSERT INTO store_notifications (id, store_id, type, severity, audience_role, message)
     VALUES ($1,$2,'expiry_alert',$3,'admin',$4)`,
    [crypto.randomUUID(), storeId, severity,
      `${expiring.length} batch${expiring.length > 1 ? 'es are' : ' is'} expiring soon — closest: ${worstLabel}${hasUrgentPerishable ? ' (refrigerated/frozen — act today)' : ''}. Check Expiry Tracker for markdown suggestions.`]
  );
  emitToStore(storeId, 'notification:new', { type: 'expiry_alert' });

  dispatchEvent(storeId, 'batch.expiring', {
    count: expiring.length,
    batches: expiring.slice(0, 20).map((b) => ({
      productName: b.productName, batchNumber: b.batchNumber, expiryDate: b.expiryDate, storageType: b.storageType,
      remaining: b.remaining, daysUntilExpiry: b.daysUntilExpiry, suggestedDiscountPct: suggestedDiscountPct(b.daysUntilExpiry, b.storageType),
    })),
  });
}

async function runExpirySweep() {
  try {
    const { rows: stores } = await db.query('SELECT id FROM stores');
    for (const store of stores) {
      try {
        await runForStore(store.id);
      } catch (err) {
        console.error(`[expiry] failed for store ${store.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[expiry] sweep failed:', err.message);
    captureException(err, { job: 'expiry' });
  }
}

let lastRunDate = null;

/** Starts the periodic sweep for server.js's always-on process. Returns a stop function. */
function startExpiryJob(intervalMs = 60 * 60 * 1000) {
  const check = () => {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== lastRunDate) {
      runExpirySweep();
      lastRunDate = today;
    }
  };
  check();
  const interval = setInterval(check, intervalMs);
  return () => clearInterval(interval);
}

module.exports = { startExpiryJob, runExpirySweep };
