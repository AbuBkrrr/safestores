// ------------------------------------------------------------
// Receipt scanning (OCR) for the standalone web edition. Postgres-flavored
// twin of desktop/server/controllers/receiptsController.js — uses backend's
// own utils/ocr.js (Tesseract.js), which returns { rawText, items } (no
// documentDate extraction the way desktop's does — see migrations/020's
// header; document_date on a synced receipt still gets stored, it's just
// not something the web edition's own OCR pass extracts itself).
// ------------------------------------------------------------

const db = require('../config/db');
const { runOcr } = require('../utils/ocr');
const { recomputeProductQuantities } = require('../utils/stockMath');
const { suggestLocation } = require('../utils/locationSuggest');
const { dispatchEvent } = require('../utils/webhooks');
const { persistUpload } = require('../utils/storage');
const { ocrSource } = require('../utils/storage');
const { emitToStore } = require('../realtime');

// GET /api/stores/:storeId/receipts
async function listReceipts(req, res) {
  const { storeId } = req.params;
  const { rows } = await db.query('SELECT * FROM receipts WHERE store_id = $1 ORDER BY created_at DESC', [storeId]);
  res.json(rows); // parsed_items is JSONB — pg already gives it back as a parsed array
}

// POST /api/stores/:storeId/receipts  (multipart field name: "receipt")
async function uploadReceipt(req, res) {
  const { storeId } = req.params;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name must be "receipt")' });

  const { url, key } = await persistUpload(req.file, { keyPrefix: `stores/${storeId}/receipts` });
  const { rawText, items } = await runOcr(ocrSource(req.file));

  const { rows } = await db.query(
    `INSERT INTO receipts (store_id, image_url, storage_key, raw_ocr_text, parsed_items, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [storeId, url, key, rawText, JSON.stringify(items), req.user.sub]
  );
  const receipt = rows[0];
  res.status(201).json(receipt);
  emitToStore(storeId, 'receipt:uploaded', receipt);
}

// POST /api/stores/:storeId/receipts/:receiptId/apply   { arrivalDate? }
async function applyReceipt(req, res) {
  const { storeId, receiptId } = req.params;
  const { arrivalDate } = req.body;

  const { rows: receiptRows } = await db.query('SELECT * FROM receipts WHERE id = $1 AND store_id = $2', [receiptId, storeId]);
  const receipt = receiptRows[0];
  if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
  if (receipt.status !== 'pending') return res.status(409).json({ error: `Receipt already ${receipt.status} — cannot re-apply` });

  // Prefer an explicit override (the admin reviewing the receipt adjusting
  // it), then the date OCR found printed on the receipt itself, then just
  // now — a receipt reviewed same-day as it arrived needs no override at
  // all, this only matters when review happens later.
  const effectiveDate = arrivalDate || receipt.document_date || new Date().toISOString();
  const arrivalTimestamp = /^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) ? `${effectiveDate}T00:00:00.000Z` : effectiveDate;

  const items = receipt.parsed_items; // already a parsed array — JSONB column

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const out = [];
    for (const item of items) {
      let { rows: productRows } = await client.query(
        `SELECT * FROM products WHERE store_id = $1 AND (LOWER(name) = LOWER($2) OR sku = $3) LIMIT 1`,
        [storeId, item.name, item.sku || '']
      );
      let product = productRows[0];

      if (!product) {
        const sku = item.sku || `AUTO-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const location = await suggestLocation(client, storeId, item.category || null);
        const { rows: inserted } = await client.query(
          `INSERT INTO products (store_id, name, sku, category, cost_price, location, backroom_qty) VALUES ($1,$2,$3,$4,$5,$6,0) RETURNING *`,
          [storeId, item.name, sku, item.category || null, item.price || 0, location]
        );
        product = inserted[0];
      }
      // Quantity is derived from stock_movements below, not incremented
      // here directly — see stockMath.js.

      const { rows: arrivalRows } = await client.query(
        `INSERT INTO stock_arrivals (store_id, product_id, quantity, receipt_id, received_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [storeId, product.id, item.quantity, receipt.id, req.user.sub, arrivalTimestamp]
      );

      await client.query(
        `INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by, created_at)
         VALUES ($1,$2,'arrival',$3,'From scanned receipt',$4,$5)`,
        [storeId, product.id, item.quantity, req.user.sub, arrivalTimestamp]
      );
      // Straight to shelf, not just backroom — per the store's workflow,
      // a scanned receipt has already been reviewed (that's what "Apply"
      // is) by the time it reaches here, so the cashier/POS should be
      // able to sell it immediately rather than needing a separate manual
      // transfer-to-shelf step first.
      await client.query(
        `INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by)
         VALUES ($1,$2,'transfer_to_shelf',$3,'Auto-transferred to shelf on receipt apply',$4)`,
        [storeId, product.id, item.quantity, req.user.sub]
      );
      await recomputeProductQuantities(client, product.id);

      out.push({ item, productId: product.id, arrivalId: arrivalRows[0].id });
    }

    await client.query(`UPDATE receipts SET status = 'applied', applied_at = now() WHERE id = $1`, [receiptId]);
    await client.query('COMMIT');

    res.json({ message: 'Receipt applied to stock', results: out });
    try {
      dispatchEvent(storeId, 'receipt.applied', { receiptId, itemCount: items.length });
      emitToStore(storeId, 'receipt:applied', { receiptId, results: out });
    } catch (sideEffectErr) {
      console.error('applyReceipt: post-response side effect failed:', sideEffectErr);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to apply receipt' });
  } finally {
    client.release();
  }
}

// PATCH /api/stores/:storeId/receipts/:receiptId/reject
async function rejectReceipt(req, res) {
  const { storeId, receiptId } = req.params;
  const { rows } = await db.query(
    `UPDATE receipts SET status = 'rejected' WHERE id = $1 AND store_id = $2 AND status = 'pending' RETURNING *`,
    [receiptId, storeId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Receipt not found or not pending' });
  res.json(rows[0]);
  emitToStore(storeId, 'receipt:rejected', rows[0]);
}

module.exports = { listReceipts, uploadReceipt, applyReceipt, rejectReceipt };
