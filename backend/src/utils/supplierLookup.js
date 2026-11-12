// ------------------------------------------------------------
// Postgres counterpart of desktop/server/utils/supplierLookup.js.
//
// Looks up a matching `suppliers` row for this store by name, creating one
// if this is the first time that name's been used, so `products.supplier_id`
// / `purchase_orders.supplier_id` stay populated for Supplier Performance
// Analytics to query against. Must be called with a client already inside
// the caller's transaction (not the pool directly) so the insert commits
// or rolls back atomically with whatever product/PO write triggered it.
// ------------------------------------------------------------

async function findOrCreateSupplier(client, storeId, name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return null;

  const { rows } = await client.query(
    'SELECT id FROM suppliers WHERE store_id = $1 AND name = $2',
    [storeId, trimmed]
  );
  if (rows[0]) return rows[0].id;

  const inserted = await client.query(
    'INSERT INTO suppliers (store_id, name) VALUES ($1, $2) RETURNING id',
    [storeId, trimmed]
  );
  return inserted.rows[0].id;
}

module.exports = { findOrCreateSupplier };
