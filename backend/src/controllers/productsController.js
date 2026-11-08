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
    const product = inserted[0];

    if (initQty > 0) {
      await client.query(
        `INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by)
         VALUES ($1, $2, 'arrival', $3, 'Initial stock on product creation', $4)`,
        [storeId, product.id, initQty, req.user.sub]
      );
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
];
const CAMEL_TO_SNAKE = {
  costPrice: 'cost_price', priceMultiplier: 'price_multiplier', reorderLevel: 'reorder_level',
  leadTimeDays: 'lead_time_days', minOrderQty: 'min_order_qty', autoReorder: 'auto_reorder', imageUrl: 'image_url',
  storageType: 'storage_type',
};

// PUT /api/stores/:storeId/products/:productId
async function updateProduct(req, res) {
  const { storeId, productId } = req.params;

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

module.exports = { listProducts, createProduct, updateProduct, deleteProduct, restoreProduct };
