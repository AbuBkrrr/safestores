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
  const initQty = Math.max(0, Math.round((Number(initialBackroomQty) || 0) * 1000) / 1000);

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

    // Sold by weight/volume/length (1.35 kg) and fresh-food shelf life.
    if (req.body.soldBy || req.body.shelfLifeDays) {
      const soldBy = ['unit', 'weight', 'volume', 'length'].includes(req.body.soldBy) ? req.body.soldBy : 'unit';
      const life = parseInt(req.body.shelfLifeDays, 10);
      db.prepare('UPDATE products SET sold_by = ?, shelf_life_days = ? WHERE id = ?').run(soldBy, life > 0 ? life : null, newId);
    }
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
      // "Put on the shelf now" — see the cloud edition.
      const toShelf = Math.min(initQty, Math.max(0, Number(req.body.putOnShelf) || 0));
      if (toShelf > 0) {
        db.prepare(
          `INSERT INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by)
           VALUES (?,?,?,'transfer_to_shelf',?, 'Put on shelf when the product was added', ?)`
        ).run(crypto.randomUUID(), storeId, newId, toShelf, req.user.sub);
      }
      require('../utils/stockMath').recomputeProductQuantities(db, newId);
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
    'barcode', 'pack_size', 'pack_unit', 'variant_of', 'variant_label', 'sold_by', 'shelf_life_days',
  ];
  const camelToSnake = {
    soldBy: 'sold_by', shelfLifeDays: 'shelf_life_days',
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
      let bound = typeof val === 'boolean' ? (val ? 1 : 0) : val;
      if (col === 'sold_by' && !['unit', 'weight', 'volume', 'length'].includes(bound)) bound = 'unit';
      if (col === 'shelf_life_days') bound = parseInt(bound, 10) > 0 ? parseInt(bound, 10) : null;
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

// POST /api/stores/:storeId/products/:productId/photo  (multipart "photo")
function setProductPhoto(req, res) {
  const { storeId, productId } = req.params;
  if (!req.file) return res.status(400).json({ error: 'Choose a photo first' });
  if (!db.prepare('SELECT id FROM products WHERE id = ? AND store_id = ?').get(productId, storeId)) return res.status(404).json({ error: 'Product not found' });
  db.prepare("UPDATE products SET image_url = ? WHERE id = ?").run(`/uploads/${req.file.filename}`, productId);
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(productId));
}

// DELETE /api/stores/:storeId/products/:productId/photo
function removeProductPhoto(req, res) {
  const r = db.prepare("UPDATE products SET image_url = NULL WHERE id = ? AND store_id = ?").run(req.params.productId, req.params.storeId);
  if (!r.changes) return res.status(404).json({ error: 'Product not found' });
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.productId));
}

// POST /api/stores/:storeId/products/markup - see the cloud edition for the rules.
function bulkMarkup(req, res) {
  const { storeId } = req.params;
  const percent = Number(req.body?.percent);
  const { scope, category } = req.body || {};
  const ids = Array.isArray(req.body?.productIds) ? req.body.productIds.map(String) : [];
  if (!Number.isFinite(percent) || percent < 0 || percent > 1000) return res.status(400).json({ error: 'Profit % must be between 0 and 1000' });
  if (!['all', 'category', 'products'].includes(scope)) return res.status(400).json({ error: 'Choose all products, a category, or some products' });
  if (scope === 'category' && !String(category || '').trim()) return res.status(400).json({ error: 'Choose a category' });
  if (scope === 'products' && !ids.length) return res.status(400).json({ error: 'Tick the products to change' });
  const params = [1 + percent / 100, storeId];
  let where = 'store_id = ? AND archived_at IS NULL';
  if (scope === 'category') { where += ' AND category = ?'; params.push(String(category).trim()); }
  if (scope === 'products') { where += ` AND id IN (${ids.map(() => '?').join(',')})`; params.push(...ids); }
  const r = db.prepare(`UPDATE products SET price_multiplier = ? WHERE ${where}`).run(...params);
  res.json({ updated: r.changes, percent });
}

module.exports = { listProducts, createProduct, updateProduct, deleteProduct, restoreProduct, setProductPhoto, removeProductPhoto, bulkMarkup };
