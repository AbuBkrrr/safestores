// ------------------------------------------------------------
// Small helper shared by anywhere that still takes a supplier as a plain
// name string (createPurchaseOrder, the auto-reorder job, product
// create/update) — looks up a matching supplier row for this store,
// creating one if this is the first time that name's been used, so
// supplier_id is always populated for anything Supplier Performance
// Analytics needs to query.
// ------------------------------------------------------------

const crypto = require('crypto');

function findOrCreateSupplier(db, storeId, name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return null;

  const existing = db.prepare('SELECT id FROM suppliers WHERE store_id = ? AND name = ?').get(storeId, trimmed);
  if (existing) return existing.id;

  const id = crypto.randomUUID();
  db.prepare('INSERT INTO suppliers (id, store_id, name) VALUES (?,?,?)').run(id, storeId, trimmed);
  return id;
}

module.exports = { findOrCreateSupplier };
