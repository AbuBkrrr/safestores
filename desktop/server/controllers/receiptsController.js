const crypto = require('crypto');
const db = require('../db');
const { runOcr } = require('../utils/ocr');
const { recomputeProductQuantities } = require('../utils/stockMath');
const { suggestLocation } = require('../utils/locationSuggest');
const { dispatchEvent } = require('../utils/webhooks');
const { emitToStore } = require('../realtime');

function listReceipts(req, res) {
  const { storeId } = req.params;
  const rows = db.prepare('SELECT * FROM receipts WHERE store_id = ? ORDER BY created_at DESC').all(storeId);
  res.json(rows.map((r) => ({ ...r, parsed_items: JSON.parse(r.parsed_items) })));
}

async function uploadReceipt(req, res) {
  const { storeId } = req.params;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name must be "receipt")' });

  const imageUrl = `/uploads/${req.file.filename}`;
  const { rawText, items, documentDate } = await runOcr(req.file.path);

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO receipts (id, store_id, image_url, raw_ocr_text, parsed_items, document_date, uploaded_by)
     VALUES (?,?,?,?,?,?,?)`
  ).run(id, storeId, imageUrl, rawText, JSON.stringify(items), documentDate, req.user.sub);

  const receipt = db.prepare('SELECT * FROM receipts WHERE id = ?').get(id);
  res.status(201).json({ ...receipt, parsed_items: JSON.parse(receipt.parsed_items) });
  emitToStore(storeId, 'receipt:uploaded', { ...receipt, parsed_items: JSON.parse(receipt.parsed_items) });
}

function applyReceipt(req, res) {
  const { storeId, receiptId } = req.params;
  const { arrivalDate } = req.body;

  const receipt = db.prepare('SELECT * FROM receipts WHERE id = ? AND store_id = ?').get(receiptId, storeId);
  if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
  if (receipt.status !== 'pending') return res.status(409).json({ error: `Receipt already ${receipt.status} — cannot re-apply` });

  // Prefer an explicit override (the admin reviewing the receipt adjusting
  // it), then the date OCR found printed on the receipt itself, then just
  // now — a receipt reviewed same-day as it arrived needs no override at
  // all, this only matters when review happens later.
  const effectiveDate = arrivalDate || receipt.document_date || new Date().toISOString();
  const arrivalTimestamp = /^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) ? `${effectiveDate}T00:00:00.000Z` : effectiveDate;

  const items = JSON.parse(receipt.parsed_items);

  try {
    const results = db.transaction(() => {
      const out = [];
      for (const item of items) {
        let product = db.prepare(
          `SELECT * FROM products WHERE store_id = ? AND (LOWER(name) = LOWER(?) OR sku = ?) LIMIT 1`
        ).get(storeId, item.name, item.sku || '');

        if (product) {
          // Quantity is derived from stock_movements below, not incremented
          // here directly — see stockMath.js.
        } else {
          const newId = crypto.randomUUID();
          const sku = item.sku || `AUTO-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
          const location = suggestLocation(db, storeId, item.category || null);
          db.prepare(
            `INSERT INTO products (id, store_id, name, sku, category, cost_price, location, backroom_qty) VALUES (?,?,?,?,?,?,?,0)`
          ).run(newId, storeId, item.name, sku, item.category || null, item.price || 0, location);
          product = db.prepare('SELECT * FROM products WHERE id = ?').get(newId);
        }

        const arrivalId = crypto.randomUUID();
        db.prepare(
          `INSERT INTO stock_arrivals (id, store_id, product_id, quantity, receipt_id, received_by, created_at)
           VALUES (?,?,?,?,?,?,?)`
        ).run(arrivalId, storeId, product.id, item.quantity, receipt.id, req.user.sub, arrivalTimestamp);

        db.prepare(
          `INSERT INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by, created_at)
           VALUES (?,?,?,'arrival',?, 'From scanned receipt', ?, ?)`
        ).run(crypto.randomUUID(), storeId, product.id, item.quantity, req.user.sub, arrivalTimestamp);
        // Straight to shelf, not just backroom — per the store's workflow,
        // a scanned receipt has already been reviewed (that's what
        // "Apply" is) by the time it reaches here, so the cashier/POS
        // should be able to sell it immediately rather than needing a
        // separate manual transfer-to-shelf step first.
        db.prepare(
          `INSERT INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by)
           VALUES (?,?,?,'transfer_to_shelf',?, 'Auto-transferred to shelf on receipt apply', ?)`
        ).run(crypto.randomUUID(), storeId, product.id, item.quantity, req.user.sub);
        recomputeProductQuantities(db, product.id);

        out.push({ item, productId: product.id, arrivalId });
      }

      db.prepare(`UPDATE receipts SET status = 'applied', applied_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(receiptId);
      return out;
    })();

    res.json({ message: 'Receipt applied to stock', results });
    try {
      dispatchEvent(storeId, 'receipt.applied', { receiptId, itemCount: items.length });
      emitToStore(storeId, 'receipt:applied', { receiptId, results });
    } catch (sideEffectErr) {
      console.error('applyReceipt: post-response side effect failed:', sideEffectErr);
    }
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to apply receipt' });
  }
}

function rejectReceipt(req, res) {
  const { storeId, receiptId } = req.params;
  db.prepare(`UPDATE receipts SET status = 'rejected' WHERE id = ? AND store_id = ? AND status = 'pending'`).run(receiptId, storeId);
  const receipt = db.prepare('SELECT * FROM receipts WHERE id = ?').get(receiptId);
  if (!receipt || receipt.status !== 'rejected') return res.status(404).json({ error: 'Receipt not found or not pending' });
  res.json(receipt);
  emitToStore(storeId, 'receipt:rejected', receipt);
}

module.exports = { listReceipts, uploadReceipt, applyReceipt, rejectReceipt };
