// ------------------------------------------------------------
// Product CRUD for the standalone web edition (LAN/self-hosted deployment
// of backend/+frontend/ — real per-user JWT logins for admin/manager/
// cashier/checkout roles, not the sync_key device-trust model the cloud
// multi-tenant deployment uses for the desktop edition's backup sync).
//
// This is the Postgres-flavored twin of
// desktop/server/controllers/productsController.js — same behavior,
// async/await + $N params instead of better-sqlite3's synchronous API.
// ------------------------------------------------------------

const db = require('../config/db');
const { logActivity } = require('../utils/activityLog');
const { findOrCreateSupplier } = require('../utils/supplierLookup');
const { emitToStore } = require('../realtime');

// GET /api/stores/:storeId/products
async function listProducts(req, res) {
  const { storeId } = req.params;
  const includeArchived = req.query.includeArchived === 'true';
  const { rows } = await db.query(
    `SELECT p.*, (p.cost_price * p.price_multiplier) AS selling_price,
            (p.backroom_qty + p.shelf_qty) AS total_qty,
            ((p.backroom_qty + p.shelf_qty) * p.cost_price) AS stock_value,
            la.created_at AS last_arrival_at, la.quantity AS last_arrival_qty,
            la.receipt_id AS last_arrival_receipt_id, r.image_url AS last_arrival_receipt_image
     FROM products p
     LEFT JOIN LATERAL (
       SELECT * FROM stock_arrivals sa
       WHERE sa.product_id = p.id ORDER BY sa.created_at DESC LIMIT 1
     ) la ON true
     LEFT JOIN receipts r ON r.id = la.receipt_id
     WHERE p.store_id = $1 ${includeArchived ? '' : 'AND p.archived_at IS NULL'}
     ORDER BY p.name ASC`,
    [storeId]
  );
  res.json(rows);
}

// POST /api/stores/:storeId/products
// `id` is an optional client-generated UUID for offline-created products —
// replaying the same creation is then a safe no-op instead of a duplicate.
async function createProduct(req, res) {
  const { storeId } = req.params;
  const {
    id, name, sku, category, supplier, unit, location, costPrice, priceMultiplier,
    reorderLevel, initialBackroomQty, leadTimeDays, minOrderQty, autoReorder, storageType,
  } = req.body;

  if (!name || !sku) return res.status(400).json({ error: 'name and sku are required' });

  if (id) {
    const { rows: already } = await db.query('SELECT * FROM products WHERE id = $1', [id]);
    if (already[0]) return res.status(201).json(already[0]);
  }

  const { rows: planRows } = await db.query(
    `SELECT t.max_products FROM stores s JOIN store_tiers t ON t.tier = s.store_tier WHERE s.id = $1`,
    [storeId]
  );
  const plan = planRows[0];
  if (plan && plan.max_products !== null && plan.max_products !== undefined) {
    const { rows: countRows } = await db.query('SELECT COUNT(*) AS c FROM products WHERE store_id = $1', [storeId]);
    if (Number(countRows[0].c) >= plan.max_products) {
      return res.status(403).json({ error: `Plan limit reached (${plan.max_products} products). Upgrade to add more.` });
    }
  }

  const { rows: existingSku } = await db.query('SELECT id FROM products WHERE store_id = $1 AND sku = $2', [storeId, sku]);
  if (existingSku[0]) return res.status(409).json({ error: 'SKU already exists for this store' });

  const initQty = Number(initialBackroomQty) || 0;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const supplierId = await findOrCreateSupplier(client, storeId, supplier);

    const insertCols = id
      ? `(id, store_id, name, sku, category, supplier, supplier_id, unit, location, cost_price, price_multiplier, reorder_level,
          lead_time_days, min_order_qty, auto_reorder, backroom_qty, storage_type)`
      : `(store_id, name, sku, category, supplier, supplier_id, unit, location, cost_price, price_multiplier, reorder_level,
          lead_time_days, min_order_qty, auto_reorder, backroom_qty, storage_type)`;
    const values = id
      ? [id, storeId, name, sku, category || null, supplier || null, supplierId, unit || 'unit', location || null,
         costPrice || 0, priceMultiplier || 1.3, reorderLevel ?? 5, leadTimeDays ?? 7, minOrderQty ?? 1, !!autoReorder, initQty, storageType || 'ambient']
      : [storeId, name, sku, category || null, supplier || null, supplierId, unit || 'unit', location || null,
         costPrice || 0, priceMultiplier || 1.3, reorderLevel ?? 5, leadTimeDays ?? 7, minOrderQty ?? 1, !!autoReorder, initQty, storageType || 'ambient'];
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

    const { rows: inserted } = await client.query(
      `INSERT INTO products ${insertCols} VALUES (${placeholders}) RETURNING *`,
      values
    );
    let product = inserted[0];
    // v26 fields (barcode, pack size, variants) — optional, set in one go.
    if (req.body.soldBy || req.body.shelfLifeDays) {
      const { rows: m } = await client.query(
        'UPDATE products SET sold_by = COALESCE($1, sold_by), shelf_life_days = $2 WHERE id = $3 RETURNING *',
        [req.body.soldBy || null, req.body.shelfLifeDays ? parseInt(req.body.shelfLifeDays, 10) : null, product.id]
      );
      product = m[0];
    }
    const { barcode, packSize, packUnit, variantOf, variantLabel } = req.body;
    if (barcode || packSize || packUnit || variantOf || variantLabel) {
      const { rows: extra } = await client.query(
        `UPDATE products SET barcode = $1, pack_size = $2, pack_unit = $3, variant_of = $4, variant_label = $5 WHERE id = $6 RETURNING *`,
        [barcode || null, Math.max(1, parseInt(packSize, 10) || 1), packUnit || null, variantOf || null, variantLabel || null, product.id]
      );
      product = extra[0];
    }

    if (initQty > 0) {
      await client.query(
        `INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by)
         VALUES ($1, $2, 'arrival', $3, 'Initial stock on product creation', $4)`,
        [storeId, product.id, initQty, req.user.sub]
      );
      // "Put on the shelf now": the new stock can be sold at checkout straight away.
      const wanted = req.body.putOnShelf === undefined && await require('../utils/autoShelf').shelfDirect(client, storeId) ? initQty : Number(req.body.putOnShelf) || 0;
      const toShelf = Math.min(initQty, Math.max(0, wanted));
      if (toShelf > 0) {
        await client.query(
          `INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by)
           VALUES ($1, $2, 'transfer_to_shelf', $3, 'Put on shelf when the product was added', $4)`,
          [storeId, product.id, toShelf, req.user.sub]
        );
        await require('../utils/stockMath').recomputeProductQuantities(client, product.id);
        product = (await client.query('SELECT * FROM products WHERE id = $1', [product.id])).rows[0];
      }
    }

    await client.query('COMMIT');
    res.status(201).json(product);
    try {
      emitToStore(storeId, 'product:created', product);
    } catch (sideEffectErr) {
      console.error('createProduct: post-response realtime side effect failed:', sideEffectErr);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'SKU already exists for this store' });
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to create product' });
  } finally {
    client.release();
  }
}

const UPDATABLE_FIELDS = [
  'name', 'sku', 'category', 'supplier', 'unit', 'location', 'cost_price', 'price_multiplier', 'reorder_level',
  'lead_time_days', 'min_order_qty', 'auto_reorder', 'brand', 'image_url', 'storage_type',
  'barcode', 'pack_size', 'pack_unit', 'variant_of', 'variant_label', 'sold_by', 'shelf_life_days',
];
const CAMEL_TO_SNAKE = {
  costPrice: 'cost_price', priceMultiplier: 'price_multiplier', reorderLevel: 'reorder_level',
  leadTimeDays: 'lead_time_days', minOrderQty: 'min_order_qty', autoReorder: 'auto_reorder', imageUrl: 'image_url',
  storageType: 'storage_type', packSize: 'pack_size', packUnit: 'pack_unit', variantOf: 'variant_of', variantLabel: 'variant_label', soldBy: 'sold_by', shelfLifeDays: 'shelf_life_days',
};

// PUT /api/stores/:storeId/products/:productId
async function updateProduct(req, res) {
  const { storeId, productId } = req.params;
  const { rows: beforeRows } = await db.query('SELECT name, cost_price, price_multiplier FROM products WHERE id = $1 AND store_id = $2', [productId, storeId]);

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const updates = [];
    const values = [];
    for (const [key, val] of Object.entries(req.body)) {
      const col = CAMEL_TO_SNAKE[key] || key;
      if (UPDATABLE_FIELDS.includes(col)) {
        values.push(val);
        updates.push(`${col} = $${values.length}`);
      }
    }
    // A changed supplier name needs its normalized supplier_id recomputed
    // too, same as at creation — see utils/supplierLookup.js.
    if (Object.prototype.hasOwnProperty.call(req.body, 'supplier')) {
      const supplierId = await findOrCreateSupplier(client, storeId, req.body.supplier);
      values.push(supplierId);
      updates.push(`supplier_id = $${values.length}`);
    }
    if (updates.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    values.push(productId, storeId);
    const { rows } = await client.query(
      `UPDATE products SET ${updates.join(', ')}, updated_at = now()
       WHERE id = $${values.length - 1} AND store_id = $${values.length} RETURNING *`,
      values
    );
    await client.query('COMMIT');
    const product = rows[0];
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json(product);
    const before = beforeRows[0];
    if (before && (Number(before.cost_price) !== Number(product.cost_price) || Number(before.price_multiplier) !== Number(product.price_multiplier))) {
      logActivity(req, { storeId, action: 'product.price_changed', entityType: 'product', entityId: productId, details: {
        name: product.name,
        from: Number(before.cost_price) * Number(before.price_multiplier),
        to: Number(product.cost_price) * Number(product.price_multiplier),
      } });
    }
    try {
      emitToStore(storeId, 'product:updated', product);
    } catch (sideEffectErr) {
      console.error('updateProduct: post-response realtime side effect failed:', sideEffectErr);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    if (res.headersSent) { console.error(err); return; }
    if (err.code === '23505') return res.status(409).json({ error: 'SKU already exists for this store' });
    console.error(err);
    res.status(500).json({ error: 'Failed to update product' });
  } finally {
    client.release();
  }
}

// DELETE /api/stores/:storeId/products/:productId
// Archives rather than deletes — a real delete would cascade away this
// product's entire arrival/movement/audit/batch history.
async function deleteProduct(req, res) {
  const { storeId, productId } = req.params;
  const { rowCount } = await db.query(
    `UPDATE products SET archived_at = now() WHERE id = $1 AND store_id = $2 AND archived_at IS NULL`,
    [productId, storeId]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Product not found or already archived' });
  res.status(204).end();
  logActivity(req, { storeId, action: 'product.archived', entityType: 'product', entityId: productId });
  emitToStore(storeId, 'product:deleted', { id: productId });
}

// PATCH /api/stores/:storeId/products/:productId/restore
async function restoreProduct(req, res) {
  const { storeId, productId } = req.params;
  const { rows } = await db.query(
    `UPDATE products SET archived_at = NULL WHERE id = $1 AND store_id = $2 AND archived_at IS NOT NULL RETURNING *`,
    [productId, storeId]
  );
  const product = rows[0];
  if (!product) return res.status(404).json({ error: 'Product not found or not archived' });
  res.json(product);
  emitToStore(storeId, 'product:updated', product);
}

// POST /api/stores/:storeId/products/:productId/photo  (multipart "photo")
// A picture of the item so staff can tell look-alike products apart.
async function setProductPhoto(req, res) {
  const { storeId, productId } = req.params;
  if (!req.file) return res.status(400).json({ error: 'Choose a photo first' });
  const found = await db.query('SELECT id FROM products WHERE id = $1 AND store_id = $2', [productId, storeId]);
  if (!found.rows[0]) return res.status(404).json({ error: 'Product not found' });
  const { url } = await require('../utils/storage').persistUpload(req.file, { keyPrefix: `stores/${storeId}/products` });
  const { rows } = await db.query('UPDATE products SET image_url = $1, updated_at = now() WHERE id = $2 RETURNING *', [url, productId]);
  res.json(rows[0]);
}

// DELETE /api/stores/:storeId/products/:productId/photo
async function removeProductPhoto(req, res) {
  const { rows } = await db.query(
    'UPDATE products SET image_url = NULL, updated_at = now() WHERE id = $1 AND store_id = $2 RETURNING *', [req.params.productId, req.params.storeId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Product not found' });
  res.json(rows[0]);
}

// POST /api/stores/:storeId/products/markup
// body: { percent, scope: 'all' | 'category' | 'products', category?, productIds? }
// Sets the profit % (selling price = cost x (1 + percent/100)) on every
// product in scope. Prices are worked out from each item's own cost.
async function bulkMarkup(req, res) {
  const { storeId } = req.params;
  const percent = Number(req.body?.percent);
  const { scope, category } = req.body || {};
  const ids = Array.isArray(req.body?.productIds) ? req.body.productIds.map(String) : [];
  if (!Number.isFinite(percent) || percent < 0 || percent > 1000) return res.status(400).json({ error: 'Profit % must be between 0 and 1000' });
  if (!['all', 'category', 'products'].includes(scope)) return res.status(400).json({ error: 'Choose all products, a category, or some products' });
  if (scope === 'category' && !String(category || '').trim()) return res.status(400).json({ error: 'Choose a category' });
  if (scope === 'products' && !ids.length) return res.status(400).json({ error: 'Tick the products to change' });
  const params = [1 + percent / 100, storeId];
  let where = 'store_id = $2 AND archived_at IS NULL';
  if (scope === 'category') { params.push(String(category).trim()); where += ` AND category = $${params.length}`; }
  if (scope === 'products') { params.push(ids); where += ` AND id::text = ANY($${params.length})`; }
  const { rowCount } = await db.query(`UPDATE products SET price_multiplier = $1, updated_at = now() WHERE ${where}`, params);
  logActivity(req, { storeId, action: 'product.bulk_markup', entityType: 'product', details: { percent, scope, category: category || null, count: rowCount } });
  res.json({ updated: rowCount, percent });
}

// POST /api/stores/:storeId/products/to-shelf  { productIds? }  — one tap: everything
// in the store room goes onto the shelf (all products, or just the ones given).
async function moveToShelf(req, res) {
  const { storeId } = req.params;
  const ids = Array.isArray(req.body?.productIds) ? req.body.productIds.map(String).slice(0, 2000) : null;
  const { rows } = await db.query(
    `SELECT id, backroom_qty FROM products WHERE store_id = $1 AND archived_at IS NULL AND backroom_qty > 0 ${ids ? 'AND id::text = ANY($2)' : ''}`,
    ids ? [storeId, ids] : [storeId]);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of rows) {
      await client.query(`INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by)
        VALUES ($1,$2,'transfer_to_shelf',$3,'Put on shelf (one tap)',$4)`, [storeId, p.id, p.backroom_qty, req.user.sub]);
      await require('../utils/stockMath').recomputeProductQuantities(client, p.id);
    }
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  res.json({ moved: rows.length, quantity: rows.reduce((n, p) => n + Number(p.backroom_qty), 0) });
}

module.exports = { moveToShelf, listProducts, createProduct, updateProduct, deleteProduct, restoreProduct, setProductPhoto, removeProductPhoto, bulkMarkup };
