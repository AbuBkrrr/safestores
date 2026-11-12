const crypto = require('crypto');
const db = require('../db');
const { findOrCreateSupplier } = require('../utils/supplierLookup');
const { emitToStore } = require('../realtime');

// GET /api/stores/:storeId/products
function listProducts(req, res) {
  const { storeId } = req.params;
  const rows = db.prepare(
    `SELECT p.*, (p.cost_price * p.price_multiplier) AS selling_price,
            (p.backroom_qty + p.shelf_qty) AS total_qty,
            ((p.backroom_qty + p.shelf_qty) * p.cost_price) AS stock_value,
            la.created_at AS last_arrival_at, la.quantity AS last_arrival_qty,
            la.receipt_id AS last_arrival_receipt_id, r.image_url AS last_arrival_receipt_image
     FROM products p
     LEFT JOIN (
       SELECT sa1.* FROM stock_arrivals sa1
       WHERE sa1.id = (SELECT sa2.id FROM stock_arrivals sa2 WHERE sa2.product_id = sa1.product_id ORDER BY sa2.created_at DESC LIMIT 1)
     ) la ON la.product_id = p.id
     LEFT JOIN receipts r ON r.id = la.receipt_id
     WHERE p.store_id = ? ${req.query.includeArchived === 'true' ? '' : 'AND p.archived_at IS NULL'} ORDER BY p.name ASC`
  ).all(storeId);
  res.json(rows);
}

// POST /api/stores/:storeId/products
// `id` is an optional client-generated UUID for offline-created products —
// replaying the same creation is then a safe no-op instead of a duplicate.
function createProduct(req, res) {
  const { storeId } = req.params;
  const {
    id, name, sku, category, supplier, unit, location, costPrice, priceMultiplier,
    reorderLevel, initialBackroomQty, leadTimeDays, minOrderQty, autoReorder, storageType,
  } = req.body;

  if (!name || !sku) return res.status(400).json({ error: 'name and sku are required' });

  if (id) {
    const already = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (already) return res.status(201).json(already);
  }

  const plan = db.prepare(
    `SELECT t.max_products FROM stores s JOIN store_tiers t ON t.tier = s.store_tier WHERE s.id = ?`
  ).get(storeId);
  if (plan && plan.max_products !== null && plan.max_products !== undefined) {
    const count = db.prepare('SELECT COUNT(*) AS c FROM products WHERE store_id = ?').get(storeId).c;
    if (count >= plan.max_products) {
      return res.status(403).json({ error: `Plan limit reached (${plan.max_products} products). Upgrade to add more.` });
    }
  }

  const existing = db.prepare('SELECT id FROM products WHERE store_id = ? AND sku = ?').get(storeId, sku);
  if (existing) return res.status(409).json({ error: 'SKU already exists for this store' });

  const newId = id || crypto.randomUUID();
  const initQty = Number(initialBackroomQty) || 0;

  db.transaction(() => {
    const supplierId = findOrCreateSupplier(db, storeId, supplier);
    db.prepare(
      `INSERT INTO products
        (id, store_id, name, sku, category, supplier, supplier_id, unit, location, cost_price, price_multiplier, reorder_level,
         lead_time_days, min_order_qty, auto_reorder, backroom_qty, storage_type)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      newId, storeId, name, sku, category || null, supplier || null, supplierId, unit || 'unit', location || null,
      costPrice || 0, priceMultiplier || 1.3, reorderLevel ?? 5,
      leadTimeDays ?? 7, minOrderQty ?? 1, autoReorder ? 1 : 0, initQty, storageType || 'ambient'
    );

    const { barcode, packSize, packUnit, variantOf, variantLabel } = req.body;
    if (barcode || packSize || packUnit || variantOf || variantLabel) {
      db.prepare('UPDATE products SET barcode = ?, pack_size = ?, pack_unit = ?, variant_of = ?, variant_label = ? WHERE id = ?')
        .run(barcode || null, Math.max(1, parseInt(packSize, 10) || 1), packUnit || null, variantOf || null, variantLabel || null, newId);
    }

    if (initQty > 0) {
      db.prepare(
        `INSERT INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by)
         VALUES (?,?,?,'arrival',?, 'Initial stock on product creation', ?)`
      ).run(crypto.randomUUID(), storeId, newId, initQty, req.user.sub);
    }
  })();

  res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(newId));
  emitToStore(storeId, 'product:created', db.prepare('SELECT * FROM products WHERE id = ?').get(newId));
}

// PUT /api/stores/:storeId/products/:productId
function updateProduct(req, res) {
  const { storeId, productId } = req.params;
  const fields = [
    'name', 'sku', 'category', 'supplier', 'unit', 'location', 'cost_price', 'price_multiplier', 'reorder_level',
    'lead_time_days', 'min_order_qty', 'auto_reorder', 'brand', 'image_url', 'storage_type',
    'barcode', 'pack_size', 'pack_unit', 'variant_of', 'variant_label',
  ];
  const camelToSnake = {
    packSize: 'pack_size', packUnit: 'pack_unit', variantOf: 'variant_of', variantLabel: 'variant_label',
    costPrice: 'cost_price', priceMultiplier: 'price_multiplier', reorderLevel: 'reorder_level',
    leadTimeDays: 'lead_time_days', minOrderQty: 'min_order_qty', autoReorder: 'auto_reorder', imageUrl: 'image_url',
    storageType: 'storage_type',
  };

  const updates = [];
  const values = [];
  for (const [key, val] of Object.entries(req.body)) {
    const col = camelToSnake[key] || key;
    if (fields.includes(col)) {
      // better-sqlite3 can't bind JS booleans directly — SQLite has no
      // boolean type anyway (auto_reorder is stored as INTEGER 0/1).
      const bound = typeof val === 'boolean' ? (val ? 1 : 0) : val;
      updates.push(`${col} = ?`); values.push(bound);
    }
  }
  // A changed supplier name needs its normalized supplier_id recomputed
  // too, same as at creation — see utils/supplierLookup.js.
  if (Object.prototype.hasOwnProperty.call(req.body, 'supplier')) {
    const supplierId = findOrCreateSupplier(db, storeId, req.body.supplier);
    updates.push('supplier_id = ?'); values.push(supplierId);
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  values.push(productId, storeId);
  const result = db.prepare(
    `UPDATE products SET ${updates.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND store_id = ?`
  ).run(...values);
  // Without this check, a request naming another store's product id (but
  // this store's own id in the URL) would silently affect zero rows here,
  // then fall through to an UNSCOPED lookup below and leak that other
  // store's product back in the 200 response — no write happens, but it's
  // a real cross-tenant read. delete/restore below already guard on
  // result.changes; this one was missing it.
  if (result.changes === 0) return res.status(404).json({ error: 'Product not found' });

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND store_id = ?').get(productId, storeId);
  res.json(product);
  emitToStore(storeId, 'product:updated', product);
}

// DELETE /api/stores/:storeId/products/:productId
// Archives rather than deletes — see schema.sqlite.sql's comment on
// products.archived_at for why: a real delete would cascade away this
// product's entire arrival/movement/audit/batch history.
function deleteProduct(req, res) {
  const { storeId, productId } = req.params;
  const result = db.prepare(
    `UPDATE products SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND store_id = ? AND archived_at IS NULL`
  ).run(productId, storeId);
  if (result.changes === 0) return res.status(404).json({ error: 'Product not found or already archived' });
  res.status(204).end();
  emitToStore(storeId, 'product:deleted', { id: productId });
}

// PATCH /api/stores/:storeId/products/:productId/restore
function restoreProduct(req, res) {
  const { storeId, productId } = req.params;
  const result = db.prepare(
    `UPDATE products SET archived_at = NULL WHERE id = ? AND store_id = ? AND archived_at IS NOT NULL`
  ).run(productId, storeId);
  if (result.changes === 0) return res.status(404).json({ error: 'Product not found or not archived' });
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  res.json(product);
  emitToStore(storeId, 'product:updated', product);
}

module.exports = { listProducts, createProduct, updateProduct, deleteProduct, restoreProduct };
