// ------------------------------------------------------------
// Stock tools: spreadsheet product import, and branch-to-branch stock
// transfers between stores that share an owner/manager.
// ------------------------------------------------------------
const crypto = require('crypto');
const db = require('../config/db');
const { normalizeRow } = require('../utils/productImport');
const { recomputeProductQuantities } = require('../utils/stockMath');
const { findOrCreateSupplier } = require('../utils/supplierLookup');
const { logActivity } = require('../utils/activityLog');
const { emitToStore } = require('../realtime');

const MAX_ROWS = 5000;

// POST /api/stores/:storeId/products/import  { rows: [{...sheet columns}], dryRun? }
// Upserts by SKU: new SKUs are created (with opening stock as an arrival
// movement), existing ones get their details/prices updated (stock is
// never overwritten — use a stock count for that).
async function importProducts(req, res) {
  const { storeId } = req.params;
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rows || rows.length === 0) return res.status(400).json({ error: 'No rows to import' });
  if (rows.length > MAX_ROWS) return res.status(400).json({ error: `Import at most ${MAX_ROWS} rows at a time` });
  const dryRun = !!req.body?.dryRun;

  const errors = []; const valid = []; const seen = new Set();
  rows.forEach((r, i) => {
    const n = normalizeRow(r);
    if (!n.ok) return errors.push({ row: i + 2, error: n.error }); // +2: header row + 1-based
    if (seen.has(n.value.sku.toLowerCase())) return errors.push({ row: i + 2, error: `Duplicate SKU in file: ${n.value.sku}` });
    seen.add(n.value.sku.toLowerCase());
    valid.push({ row: i + 2, ...n.value });
  });

  const { rows: existing } = await db.query('SELECT id, sku FROM products WHERE store_id = $1', [storeId]);
  const bySku = new Map(existing.map((p) => [p.sku.toLowerCase(), p.id]));
  const toCreate = valid.filter((v) => !bySku.has(v.sku.toLowerCase()));
  const toUpdate = valid.filter((v) => bySku.has(v.sku.toLowerCase()));

  const { rows: planRows } = await db.query(
    'SELECT t.max_products FROM stores s JOIN store_tiers t ON t.tier = s.store_tier WHERE s.id = $1', [storeId]
  );
  const max = planRows[0]?.max_products;
  if (max != null && existing.length + toCreate.length > max) {
    return res.status(403).json({ error: `This import would take you past your plan's ${max}-product limit (${existing.length} now, ${toCreate.length} new).` });
  }
  if (dryRun) return res.json({ dryRun: true, create: toCreate.length, update: toUpdate.length, errors });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (const v of toCreate) {
      const supplierId = v.supplier ? await findOrCreateSupplier(client, storeId, v.supplier) : null;
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO products (id, store_id, name, sku, barcode, category, brand, supplier, supplier_id, unit, location, cost_price, price_multiplier, reorder_level, pack_size)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [id, storeId, v.name, v.sku, v.barcode, v.category, v.brand, v.supplier, supplierId, v.unit || 'unit', v.location,
          v.costPrice ?? 0, v.priceMultiplier ?? 1.3, v.reorderLevel ?? 5, v.packSize ?? 1]
      );
      if (v.openingStock > 0) {
        await client.query(
          `INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by) VALUES ($1,$2,'arrival',$3,'Opening stock (import)',$4)`,
          [storeId, id, v.openingStock, req.user.sub]
        );
        await recomputeProductQuantities(client, id);
      }
    }
    for (const v of toUpdate) {
      const sets = ['name = $1']; const vals = [v.name];
      const add = (col, val) => { if (val !== null && val !== undefined) { vals.push(val); sets.push(`${col} = $${vals.length}`); } };
      add('barcode', v.barcode); add('category', v.category); add('brand', v.brand); add('unit', v.unit); add('location', v.location);
      add('cost_price', v.costPrice); add('price_multiplier', v.priceMultiplier); add('reorder_level', v.reorderLevel); add('pack_size', v.packSize);
      if (v.supplier) { add('supplier', v.supplier); add('supplier_id', await findOrCreateSupplier(client, storeId, v.supplier)); }
      vals.push(bySku.get(v.sku.toLowerCase()), storeId);
      await client.query(`UPDATE products SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length - 1} AND store_id = $${vals.length}`, vals);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    if (err.code === '23505') return res.status(409).json({ error: 'A SKU in the file clashes with an existing product' });
    return res.status(500).json({ error: 'Import failed — nothing was changed' });
  } finally {
    client.release();
  }
  logActivity(req, { storeId, action: 'product.imported', entityType: 'store', entityId: storeId, details: { created: toCreate.length, updated: toUpdate.length, skipped: errors.length } });
  try { emitToStore(storeId, 'product:bulk', {}); } catch { /* best-effort */ }
  res.json({ created: toCreate.length, updated: toUpdate.length, errors });
}

// ---------------- Branch transfers ----------------

/** Stores this person can send stock to: every other active store where the
 * same email has an active admin/manager account (an owner's branches). */
async function destinations(req, res) {
  const { storeId } = req.params;
  const { rows } = await db.query(
    `SELECT DISTINCT s.id, s.name, s.city FROM users me
     JOIN users them ON lower(them.email) = lower(me.email) AND them.role IN ('admin','manager') AND them.status = 'active'
     JOIN stores s ON s.id = them.store_id AND s.subscription_status = 'active'
     WHERE me.id = $1 AND s.id <> $2 ORDER BY s.name`,
    [req.user.sub, storeId]
  );
  res.json(rows);
}

async function listTransfers(req, res) {
  const { storeId } = req.params;
  const { rows } = await db.query(
    `SELECT t.*, sf.name AS from_store_name, st.name AS to_store_name, u.name AS created_by_name,
            (SELECT COALESCE(json_agg(json_build_object('sku', i.sku, 'name', i.name, 'quantity', i.quantity)), '[]'::json)
               FROM stock_transfer_items i WHERE i.transfer_id = t.id) AS items,
            CASE WHEN t.from_store_id = $1 THEN 'out' ELSE 'in' END AS direction
     FROM stock_transfers t JOIN stores sf ON sf.id = t.from_store_id JOIN stores st ON st.id = t.to_store_id
     LEFT JOIN users u ON u.id = t.created_by
     WHERE t.from_store_id = $1 OR t.to_store_id = $1 ORDER BY t.created_at DESC LIMIT 200`,
    [storeId]
  );
  res.json(rows);
}

// POST /transfers { toStoreId, items: [{ productId, quantity }], note }
// Stock leaves the sender's BACKROOM immediately ('transfer_out'), and
// arrives in the receiver's backroom when they confirm receipt.
async function createTransfer(req, res) {
  const { storeId } = req.params;
  const { toStoreId, items = [], note = null } = req.body || {};
  if (!toStoreId || !Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Choose a destination branch and at least one item' });
  const { rows: allowed } = await db.query(
    `SELECT 1 FROM users me JOIN users them ON lower(them.email) = lower(me.email) AND them.store_id = $2
       AND them.role IN ('admin','manager') AND them.status = 'active'
     WHERE me.id = $1`, [req.user.sub, toStoreId]
  );
  if (!allowed[0] || toStoreId === storeId) return res.status(403).json({ error: 'You can only send stock to another branch you manage' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const transferId = crypto.randomUUID();
    await client.query(
      'INSERT INTO stock_transfers (id, from_store_id, to_store_id, note, created_by) VALUES ($1,$2,$3,$4,$5)',
      [transferId, storeId, toStoreId, note ? String(note).slice(0, 300) : null, req.user.sub]
    );
    for (const it of items) {
      const qty = parseInt(it.quantity, 10);
      const { rows: p } = await client.query('SELECT * FROM products WHERE id = $1 AND store_id = $2 FOR UPDATE', [it.productId, storeId]);
      if (!p[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Product not found' }); }
      if (!(qty > 0) || qty > p[0].backroom_qty) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Only ${p[0].backroom_qty} of ${p[0].name} in the backroom to send` });
      }
      await client.query(
        `INSERT INTO stock_transfer_items (transfer_id, from_product_id, sku, name, quantity, unit_cost) VALUES ($1,$2,$3,$4,$5,$6)`,
        [transferId, p[0].id, p[0].sku, p[0].name, qty, p[0].cost_price]
      );
      await client.query(
        `INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by) VALUES ($1,$2,'transfer_out',$3,$4,$5)`,
        [storeId, p[0].id, qty, `Transfer to branch (${transferId.slice(0, 8)})`, req.user.sub]
      );
      await recomputeProductQuantities(client, p[0].id);
    }
    await client.query('COMMIT');
    logActivity(req, { storeId, action: 'stock.transfer_sent', entityType: 'transfer', entityId: transferId, details: { toStoreId, lines: items.length } });
    try { emitToStore(toStoreId, 'transfer:incoming', { id: transferId }); } catch { /* best-effort */ }
    res.status(201).json({ id: transferId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to create transfer' });
  } finally {
    client.release();
  }
}

// POST /transfers/:transferId/receive — at the RECEIVING store. Matches
// products by SKU, creating any the branch doesn't stock yet.
async function receiveTransfer(req, res) {
  const { storeId, transferId } = req.params;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: t } = await client.query('SELECT * FROM stock_transfers WHERE id = $1 AND to_store_id = $2 FOR UPDATE', [transferId, storeId]);
    if (!t[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Transfer not found' }); }
    if (t[0].status !== 'in_transit') { await client.query('ROLLBACK'); return res.status(400).json({ error: `Transfer is already ${t[0].status}` }); }
    const { rows: items } = await client.query('SELECT * FROM stock_transfer_items WHERE transfer_id = $1', [transferId]);
    for (const it of items) {
      let { rows: p } = await client.query('SELECT id FROM products WHERE store_id = $1 AND sku = $2', [storeId, it.sku]);
      let productId = p[0]?.id;
      if (!productId) {
        const { rows: src } = await client.query('SELECT * FROM products WHERE id = $1', [it.from_product_id]);
        const s = src[0] || {};
        const { rows: created } = await client.query(
          `INSERT INTO products (store_id, name, sku, barcode, category, brand, unit, cost_price, price_multiplier, reorder_level, pack_size, storage_type)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12,'ambient')) RETURNING id`,
          [storeId, it.name, it.sku, s.barcode || null, s.category || null, s.brand || null, s.unit || 'unit', it.unit_cost || 0,
            s.price_multiplier || 1.3, s.reorder_level || 5, s.pack_size || 1, s.storage_type || null]
        );
        productId = created[0].id;
      }
      await client.query(
        `INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by) VALUES ($1,$2,'arrival',$3,$4,$5)`,
        [storeId, productId, it.quantity, `Transfer from branch (${transferId.slice(0, 8)})`, req.user.sub]
      );
      await recomputeProductQuantities(client, productId);
      await client.query('UPDATE stock_transfer_items SET to_product_id = $1 WHERE id = $2', [productId, it.id]);
    }
    await client.query(`UPDATE stock_transfers SET status = 'received', received_by = $1, received_at = now() WHERE id = $2`, [req.user.sub, transferId]);
    await client.query('COMMIT');
    logActivity(req, { storeId, action: 'stock.transfer_received', entityType: 'transfer', entityId: transferId });
    res.json({ message: 'Transfer received into the backroom' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to receive transfer' });
  } finally {
    client.release();
  }
}

// POST /transfers/:transferId/cancel — sender only, while still in transit: stock goes back.
async function cancelTransfer(req, res) {
  const { storeId, transferId } = req.params;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: t } = await client.query('SELECT * FROM stock_transfers WHERE id = $1 AND from_store_id = $2 FOR UPDATE', [transferId, storeId]);
    if (!t[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Transfer not found' }); }
    if (t[0].status !== 'in_transit') { await client.query('ROLLBACK'); return res.status(400).json({ error: `Transfer is already ${t[0].status}` }); }
    const { rows: items } = await client.query('SELECT * FROM stock_transfer_items WHERE transfer_id = $1', [transferId]);
    for (const it of items) {
      if (!it.from_product_id) continue;
      await client.query(
        `INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by) VALUES ($1,$2,'backroom_adjustment',$3,'Transfer cancelled',$4)`,
        [storeId, it.from_product_id, it.quantity, req.user.sub]
      );
      await recomputeProductQuantities(client, it.from_product_id);
    }
    await client.query(`UPDATE stock_transfers SET status = 'cancelled' WHERE id = $1`, [transferId]);
    await client.query('COMMIT');
    res.json({ message: 'Transfer cancelled; stock is back in your backroom' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to cancel transfer' });
  } finally {
    client.release();
  }
}

module.exports = { importProducts, destinations, listTransfers, createTransfer, receiveTransfer, cancelTransfer };
