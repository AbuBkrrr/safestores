// SQLite counterpart of backend/src/utils/stockMath.js — same reasoning:
// quantities are recomputed from the stock_movements event log (a pure SUM,
// safe to merge regardless of what order events arrive in from other
// devices), never incremented in place. See that file for the full
// rationale.

function recomputeProductQuantities(db, productId) {
  const q = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'arrival' THEN quantity
                          WHEN type = 'transfer_to_shelf' THEN -quantity
                          WHEN type = 'backroom_adjustment' THEN quantity
                          WHEN type = 'transfer_out' THEN -quantity
                          ELSE 0 END), 0) AS backroom_qty,
       COALESCE(SUM(CASE WHEN type = 'transfer_to_shelf' THEN quantity
                          WHEN type IN ('sale', 'damage', 'expiry') THEN -quantity
                          WHEN type = 'adjustment' THEN quantity
                          WHEN type = 'return' THEN quantity
                          ELSE 0 END), 0) AS shelf_qty,
       COALESCE(SUM(CASE WHEN type = 'sale' THEN quantity
                          WHEN type = 'return' THEN -quantity
                          ELSE 0 END), 0) AS sold_qty,
       COALESCE(SUM(CASE WHEN type IN ('damage', 'expiry') THEN quantity ELSE 0 END), 0) AS damaged_qty
     FROM stock_movements WHERE product_id = ?`
  ).get(productId);

  db.prepare(
    `UPDATE products SET backroom_qty = ?, shelf_qty = ?, sold_qty = ?, damaged_qty = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  ).run(q.backroom_qty, q.shelf_qty, q.sold_qty, q.damaged_qty, productId);

  return db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
}

module.exports = { recomputeProductQuantities };
