// ------------------------------------------------------------
// Stock quantities as a derived value, not a mutated one.
//
// Every stock-affecting action (arrival, transfer, sale, damage, expiry,
// adjustment) is already logged as a row in stock_movements. Instead of
// separately incrementing products.shelf_qty/backroom_qty/etc. in place —
// which is NOT safe to merge when two offline devices each recorded
// changes independently — this recomputes the cached columns from a pure
// SUM over the event log every time. A SUM over an append-only,
// UUID-keyed table is commutative: it doesn't matter what order the rows
// arrive in (e.g. after merging two devices' offline movement logs), the
// result is always correct. This is what makes offline-first sync safe.
//
// The products table still stores shelf_qty/backroom_qty/etc. as plain
// columns — that's kept as a fast-read cache — but they are ALWAYS
// overwritten from this computation, never incremented directly.
// ------------------------------------------------------------

async function recomputeProductQuantities(client, productId) {
  const { rows } = await client.query(
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'arrival' THEN quantity
                          WHEN type = 'transfer_to_shelf' THEN -quantity
                          WHEN type = 'backroom_adjustment' THEN quantity
                          ELSE 0 END), 0) AS backroom_qty,
       COALESCE(SUM(CASE WHEN type = 'transfer_to_shelf' THEN quantity
                          WHEN type IN ('sale', 'damage', 'expiry') THEN -quantity
                          WHEN type = 'adjustment' THEN quantity
                          ELSE 0 END), 0) AS shelf_qty,
       COALESCE(SUM(CASE WHEN type = 'sale' THEN quantity ELSE 0 END), 0) AS sold_qty,
       COALESCE(SUM(CASE WHEN type IN ('damage', 'expiry') THEN quantity ELSE 0 END), 0) AS damaged_qty
     FROM stock_movements WHERE product_id = $1`,
    [productId]
  );
  const q = rows[0];
  const { rows: updated } = await client.query(
    `UPDATE products SET backroom_qty = $1, shelf_qty = $2, sold_qty = $3, damaged_qty = $4, updated_at = now()
     WHERE id = $5 RETURNING *`,
    [q.backroom_qty, q.shelf_qty, q.sold_qty, q.damaged_qty, productId]
  );
  return updated[0];
}

module.exports = { recomputeProductQuantities };
