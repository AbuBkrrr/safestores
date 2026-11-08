// ------------------------------------------------------------
// Expiry & Batch Tracking for the standalone web edition. Postgres-flavored
// twin of desktop/server/controllers/batchesController.js — the FIFO
// remaining-quantity allocation logic in utils/batches.js is pure JS,
// copied over unchanged.
// ------------------------------------------------------------

const db = require('../config/db');
const { allocateFifoRemaining, suggestedDiscountPct, alertWindowDays, daysUntil } = require('../utils/batches');

async function loadBatchesWithRemaining(storeId) {
  const { rows: batchRows } = await db.query(
    `SELECT b.id, b.product_id, b.batch_number, b.expiry_date, b.quantity_received, b.created_at,
            p.name AS product_name, p.sku, p.storage_type
     FROM batches b JOIN products p ON p.id = b.product_id
     WHERE b.store_id = $1`,
    [storeId]
  );
  if (batchRows.length === 0) return [];

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
      batchNumber: b.batch_number, productName: b.product_name, sku: b.sku,
      storageType: b.storage_type, createdAt: b.created_at,
    });
  }

  const result = [];
  for (const [productId, batches] of byProduct) {
    const withRemaining = allocateFifoRemaining(batches, consumedMap.get(productId) || 0);
    result.push(...withRemaining);
  }
  return result;
}

// GET /api/stores/:storeId/batches?includeDepleted=true
async function listBatches(req, res) {
  const { storeId } = req.params;
  const includeDepleted = req.query.includeDepleted === 'true';
  const all = await loadBatchesWithRemaining(storeId);
  const filtered = includeDepleted ? all : all.filter((b) => b.remaining > 0);
  filtered.sort((a, b) => new Date(a.expiryDate) - new Date(b.expiryDate));
  res.json(filtered);
}

// GET /api/stores/:storeId/batches/expiring?days=30 — `days`, if given,
// overrides the storage-type-aware default window for every batch
// uniformly; omit it to let refrigerated/frozen items use their own
// (much shorter) default window instead of ambient's.
async function listExpiringBatches(req, res) {
  const { storeId } = req.params;
  const overrideWindow = req.query.days !== undefined ? Number(req.query.days) : null;
  const all = await loadBatchesWithRemaining(storeId);
  const expiring = all
    .filter((b) => b.remaining > 0)
    .map((b) => {
      const daysLeft = daysUntil(b.expiryDate);
      return {
        ...b,
        daysUntilExpiry: daysLeft,
        isExpired: daysLeft < 0,
        suggestedDiscountPct: suggestedDiscountPct(daysLeft, b.storageType),
      };
    })
    .filter((b) => b.isExpired || b.daysUntilExpiry <= (overrideWindow ?? alertWindowDays(b.storageType)))
    .sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);
  res.json(expiring);
}

module.exports = { listBatches, listExpiringBatches };
